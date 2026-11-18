---
name: audio-crawler
description: 音频爬虫。用于从抖音分享短链或作品页快速提取并下载音频，核对作品、音源和时长，交付本地音频文件。
---

# 音频爬虫

用户说“爬取音频”“只提取音频”时，交付可下载的本地音频文件。优先获取作品的独立音轨或可确认完整对应的原声 MP3，保留源编码。用户指定格式时再转码。

## 抖音

1. 用 Scrapling 的 `make_request` 发起 HTTP 请求并跟随短链跳转。读取最终 URL 中的作品 ID（`/share/video/<ID>/` 或 `/video/<ID>`）和原声 ID（`mid`）。如果响应已经包含可验证的音频地址，直接使用。短链没有提供可用媒体且带有 `mid` 时，直接转网页版原声页 `https://www.douyin.com/music/<mid>`。
2. 用 Scrapling 的 `browser_open`、`browser_fetch` 加载原声页。可指定本机已装的 Chromium 浏览器路径，避免因工具默认浏览器缺失而等待。用 `disable_resources: true` 跳过媒体加载，用作品 ID 对应的链接作为等待目标，给导航设置有限超时。随后用 `browser_evaluate` 和 `isolated_context: false` 执行下方片段。若作品未出现在原声页，检查原声页已收到的请求中是否有匹配该 ID 的作品记录，再按需打开作品页。结束时关闭自己创建的会话。
3. 下载前确认返回的作品 ID。若原声作者与作品创作者相符，可用页面卡片确认，且原声时长与作品时长相符，可直接下载 `music.playUrl.urlList` 中的 MP3。若发现使用了其他作品的配乐、原声时长不同或音源对应关系不清楚，改取该作品的 `video.bitRateAudioList` 中可用的独立音轨。优先用平台返回的一个 CDN 地址，遇到超时或失效时立即尝试同一音轨的备用地址。只有可用媒体确实把画面和声音封装在一起时，才在取得用户所需音频的范围内，用 FFmpeg 提取音轨。用户明确限制网络请求只能取音频时，合并媒体视为不可用。
4. 先下载到临时文件，以 `ffprobe` 验证有音轨、无视频轨并读取时长。Windows 无 `ffprobe` 时，可用 Shell 属性读取 MP3 的 `System.Media.Duration` 和 `System.Audio.EncodingBitrate`。核对音频时长与作品时长，允许约一秒的舍入及编码差异。有明显偏差时检查备用音源。通过校验后仅交付音频文件。用户问速度时，说明计时口径，并用本次实测时间。

### 从原声页匹配准确作品

将 `arg` 设为 `{"id":"从短链读出的作品 ID"}`。该片段读取原声页公开展示的数据。遇到页面结构变动时，改读该页已返回的作品元数据。

```js
({ id }) => {
  if (!/^\d+$/.test(id)) return null;
  const link = Array.from(document.querySelectorAll('a[href*="/video/"]'))
    .find((element) => new URL(element.href).pathname.replace(/\/$/, "") === "/video/" + id);
  if (!link) return null;

  const key = Object.keys(link).find((name) => name.startsWith("__reactFiber"));
  for (let node = link[key]; node; node = node.return) {
    const item = node.memoizedProps?.awemeInfo;
    if (String(item?.awemeId) !== id) continue;
    return {
      id,
      cardText: link.innerText,
      description: item.desc,
      videoDurationMs: item.video?.duration,
      musicTitle: item.music?.title,
      musicAuthor: item.music?.author,
      musicDurationSeconds: item.music?.duration,
      musicUrls: item.music?.playUrl?.urlList,
      audioTracks: item.video?.bitRateAudioList,
    };
  }
  return null;
}
```
