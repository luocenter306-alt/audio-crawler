import puppeteer from "@cloudflare/puppeteer";
import indexHtml from "../web/index.html";

const shareHosts = new Set(["v.douyin.com", "www.iesdouyin.com", "www.douyin.com"]);
const audioDomains = ["douyinstatic.com", "douyinvod.com"];
const maxAudioBytes = 32 * 1024 * 1024;
const maxInputBytes = 4096;
const mobileAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

class ExtractionError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

function isAllowed(url, audio = false) {
  return url.protocol === "https:" && !url.port && !url.username && !url.password
    && (audio
      ? audioDomains.some(domain => url.hostname === domain || url.hostname.endsWith("." + domain))
      : shareHosts.has(url.hostname));
}

async function fetchSource(url, audio = false) {
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!isAllowed(url, audio)) throw new ExtractionError("不支持这个链接或跳转地址。");
    const response = await fetch(url, {
      redirect: "manual",
      headers: audio ? { "Accept-Encoding": "identity" } : { "User-Agent": mobileAgent },
      signal: AbortSignal.timeout(audio ? 20000 : 9000)
    });
    if (response.status < 300 || response.status >= 400) return { response, url };
    const target = response.headers.get("location");
    await response.body?.cancel();
    if (!target) break;
    url = new URL(target, url);
  }
  throw new ExtractionError("无法读取抖音分享链接的跳转地址。");
}

async function getShareIds(shareUrl) {
  const { response, url } = await fetchSource(shareUrl);
  await response.body?.cancel();
  if (!response.ok) throw new ExtractionError("抖音分享页暂时无法访问。", 502);
  const videoId = url.pathname.match(/\/video\/(\d+)\/?$/)?.[1];
  const musicId = url.searchParams.get("mid");
  if (!videoId || !musicId || !/^\d+$/.test(musicId)) {
    throw new ExtractionError("链接没有包含作品和原声信息，请从抖音重新复制分享链接。");
  }
  return { videoId, musicId };
}

function readCard(id) {
  const link = [...document.querySelectorAll('a[href*="/video/"]')]
    .find(item => new URL(item.href).pathname.replace(/\/$/, "") === "/video/" + id);
  if (!link) return null;
  const fiberKey = Object.keys(link).find(key => key.startsWith("__reactFiber"));
  for (let node = link[fiberKey]; node; node = node.return) {
    const item = node.memoizedProps?.awemeInfo;
    if (String(item?.awemeId) !== id) continue;
    const music = item.music;
    const duration = item.video?.duration / 1000;
    const isOriginal = music?.author && link.innerText.includes("@" + music.author);
    const originalUrls = isOriginal && Math.abs(music.duration - duration) <= 1
      ? music.playUrl?.urlList ?? [] : [];
    const separateUrls = (item.video?.bitRateAudioList ?? [])
      .filter(track => track.mediaType === "audio")
      .flatMap(track => (track.urlList ?? []).map(url => url.src))
      .filter(url => typeof url === "string" && url.includes("/media-audio-"));
    return { originalUrls, separateUrls };
  }
  return null;
}

async function getAudioSources(binding, videoId, musicId) {
  const browser = await puppeteer.launch(binding);
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", request => {
      const ignored = ["image", "font", "media", "stylesheet"].includes(request.resourceType());
      return ignored ? request.abort() : request.continue();
    });
    await page.goto("https://www.douyin.com/music/" + musicId, {
      waitUntil: "domcontentloaded", timeout: 15000
    });
    const card = await page.waitForFunction(readCard, { timeout: 12000 }, videoId);
    const { originalUrls, separateUrls } = await card.jsonValue();
    return [
      ...originalUrls.filter(url => typeof url === "string" && url.endsWith(".mp3")).map(url => [url, "mp3"]),
      ...separateUrls.map(url => [url, "m4a"])
    ];
  } finally {
    await browser.close();
  }
}

async function streamAudio(sources, videoId) {
  for (const [address, extension] of sources.slice(0, 4)) {
    try {
      const { response } = await fetchSource(new URL(address), true);
      const size = Number(response.headers.get("content-length"));
      const type = response.headers.get("content-type") ?? "";
      const audioType = extension === "mp3" ? "audio/mpeg" : "audio/mp4";
      const allowedType = extension === "mp3"
        ? /^(audio\/|application\/octet-stream)/i.test(type)
        : /^(audio\/|video\/mp4|application\/octet-stream)/i.test(type);
      if (!response.ok || !response.body || !Number.isSafeInteger(size)
          || size <= 0 || size > maxAudioBytes || !allowedType) {
        await response.body?.cancel();
        continue;
      }
      return new Response(response.body, {
        headers: {
          "Content-Type": audioType,
          "Content-Length": String(size),
          "Content-Disposition": `attachment; filename="douyin-${videoId}.${extension}"`,
          "Cache-Control": "no-store"
        }
      });
    } catch {
      // An unavailable CDN address can have another address for the same track.
    }
  }
  throw new ExtractionError("原声页没有提供可下载的独立音轨。", 502);
}

async function requestUrl(request) {
  let value;
  try {
    if (Number(request.headers.get("content-length")) > maxInputBytes || !request.body) throw new Error();
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let payload = "";
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.length;
      if (size > maxInputBytes) {
        await reader.cancel();
        throw new Error();
      }
      payload += decoder.decode(chunk, { stream: true });
    }
    payload += decoder.decode();
    const { url } = JSON.parse(payload);
    if (typeof url !== "string" || url.length > 2048) throw new Error();
    value = new URL(url.trim());
  } catch {
    throw new ExtractionError("请输入有效的抖音 HTTPS 分享链接。");
  }
  if (!isAllowed(value)) throw new ExtractionError("请输入有效的抖音 HTTPS 分享链接。");
  return value;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/") {
      return new Response(indexHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (request.method === "GET" && pathname === "/health") return Response.json({ status: "ok" });
    if (pathname !== "/api/audio") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    try {
      const shareUrl = await requestUrl(request);
      const { videoId, musicId } = await getShareIds(shareUrl);
      const sources = await getAudioSources(env.BROWSER, videoId, musicId);
      return await streamAudio(sources, videoId);
    } catch (error) {
      if (error instanceof ExtractionError) return Response.json({ detail: error.message }, { status: error.status });
      if (error.status === 429 || /\b429\b/.test(error.message)) {
        return Response.json({ detail: "云端浏览器暂时繁忙或已达到免费额度，请稍后重试。" }, { status: 429 });
      }
      console.error("Audio extraction failed", error.name);
      return Response.json({ detail: "云端暂时无法读取这条抖音作品，请稍后重试。" }, { status: 502 });
    }
  }
};
