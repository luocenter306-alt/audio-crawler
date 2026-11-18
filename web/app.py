import re
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from mutagen import File as read_audio
from patchright.sync_api import Error as BrowserError
from pydantic import BaseModel, Field
from scrapling.fetchers import StealthySession
from starlette.background import BackgroundTask


ROOT = Path(__file__).resolve().parent
SHARE_HOSTS = {"v.douyin.com", "www.iesdouyin.com", "www.douyin.com"}
MEDIA_DOMAINS = ("douyinstatic.com", "douyinvod.com")
MAX_AUDIO_BYTES = 32 * 1024 * 1024
MOBILE_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"
)
EXTRACT_CARD = r"""
id => {
  const link = [...document.querySelectorAll('a[href*="/video/"]')]
    .find(a => new URL(a.href).pathname.replace(/\/$/, '') === '/video/' + id);
  if (!link) return null;
  const fiberKey = Object.keys(link).find(key => key.startsWith('__reactFiber'));
  for (let node = link[fiberKey]; node; node = node.return) {
    const item = node.memoizedProps?.awemeInfo;
    if (String(item?.awemeId) !== id) continue;
    const music = item.music;
    const audio = (item.video?.bitRateAudioList ?? [])
      .filter(track => track.mediaType === 'audio')
      .flatMap(track => (track.urlList ?? []).map(url => url.src))
      .filter(url => typeof url === 'string' && url.includes('/media-audio-'));
    return {
      durationMs: item.video?.duration,
      musicDuration: music?.duration,
      isOriginal: !!music?.author && link.innerText.includes('@' + music.author),
      musicUrls: music?.playUrl?.urlList ?? [],
      audioUrls: audio
    };
  }
  return null;
}
"""

app = FastAPI(title="抖音音频提取")


class LinkInput(BaseModel):
    url: str = Field(max_length=2048)


class ExtractionError(Exception):
    pass


def allowed_url(url, *, media=False):
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
        valid_host = (
            any(host == domain or host.endswith("." + domain) for domain in MEDIA_DOMAINS)
            if media else host in SHARE_HOSTS
        )
        return (
            parts.scheme == "https" and valid_host and parts.port in (None, 443)
            and parts.username is None and parts.password is None
        )
    except (ValueError, TypeError):
        return False


class SafeRedirect(HTTPRedirectHandler):
    def __init__(self, *, media=False):
        self.media = media

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed_url(newurl, media=self.media):
            raise ExtractionError("来源返回了无法识别的跳转地址。")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def share_ids(url):
    if not allowed_url(url):
        raise ExtractionError("请输入有效的抖音 HTTPS 分享链接。")
    with build_opener(SafeRedirect()).open(
        Request(url, headers={"User-Agent": MOBILE_AGENT}), timeout=10
    ) as response:
        resolved = urlsplit(response.geturl())
    match = re.search(r"/video/(\d+)/?$", resolved.path)
    music_id = parse_qs(resolved.query).get("mid", [""])[0]
    if not match or not re.fullmatch(r"\d+", music_id):
        raise ExtractionError("这个链接没有提供作品和原声信息，请用抖音 App 重新复制分享链接。")
    return match.group(1), music_id


def resolve_card(video_id, music_id):
    found = None

    def read_card(page):
        nonlocal found
        found = page.evaluate(EXTRACT_CARD, arg=video_id, isolated_context=False)

    with StealthySession(
        real_chrome=True, block_ads=True, disable_resources=True, timeout=14000,
    ) as browser:
        browser.fetch(
            f"https://www.douyin.com/music/{music_id}",
            google_search=False,
            wait_selector=f'a[href*="/video/{video_id}"]',
            page_action=read_card,
        )
    if found is None:
        raise ExtractionError("原声页没有找到这条作品的音轨信息。")
    return found


def download_audio(url, destination, seconds):
    if not allowed_url(url, media=True):
        raise ExtractionError("音频地址的来源不受支持。")
    opener = build_opener(SafeRedirect(media=True))
    request = Request(url, headers={"User-Agent": MOBILE_AGENT, "Referer": "https://www.douyin.com/"})
    with opener.open(request, timeout=12) as response, destination.open("wb") as output:
        size = 0
        while chunk := response.read(128 * 1024):
            size += len(chunk)
            if size > MAX_AUDIO_BYTES:
                raise ExtractionError("这条音频超过 32 MB。")
            output.write(chunk)
    audio = read_audio(destination)
    if not audio or abs(audio.info.length - seconds) > 1:
        raise ExtractionError("下载的音频与作品时长不符。")
    return destination


def extract_audio(url, directory):
    video_id, music_id = share_ids(url)
    card = resolve_card(video_id, music_id)
    seconds = (card.get("durationMs") or 0) / 1000
    if seconds <= 0:
        raise ExtractionError("这个作品没有可核对的时长。")
    candidates = []
    if card["isOriginal"] and abs((card.get("musicDuration") or 0) - seconds) <= 1:
        candidates.extend((url, "mp3") for url in card["musicUrls"][:2]
                          if isinstance(url, str) and urlsplit(url).path.endswith(".mp3"))
    candidates.extend((url, "m4a") for url in dict.fromkeys(card["audioUrls"]))
    last_error = None
    for audio_url, extension in candidates:
        try:
            return download_audio(audio_url, directory / f"douyin-{video_id}.{extension}", seconds)
        except (ExtractionError, OSError, ValueError) as error:
            last_error = error
    raise ExtractionError("没有找到可下载且时长匹配的独立音轨。") from last_error


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(ROOT / "index.html", media_type="text/html")


@app.post("/api/audio")
def audio(request: LinkInput):
    temporary = TemporaryDirectory(prefix="douyin-audio-")
    try:
        file = extract_audio(request.url.strip(), Path(temporary.name))
    except ExtractionError as error:
        temporary.cleanup()
        raise HTTPException(422, str(error)) from error
    except (BrowserError, URLError, OSError) as error:
        temporary.cleanup()
        raise HTTPException(502, "暂时无法读取抖音原声页，请检查网络和 Chrome 后重试。") from error
    except Exception:
        temporary.cleanup()
        raise
    return FileResponse(
        file, filename=file.name,
        media_type="audio/mpeg" if file.suffix == ".mp3" else "audio/mp4",
        background=BackgroundTask(temporary.cleanup),
    )
