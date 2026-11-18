# Cloudflare 云端版

Worker 复用 `web/index.html`，用 Browser Run 解析抖音原声页，返回音频下载。部署后可以在手机或电脑上访问 Cloudflare 分配的 `workers.dev` 地址。

在 `cloudflare` 目录依次运行：

```sh
npm ci
npx wrangler login
npx wrangler deploy --dry-run
npx wrangler deploy
```

部署后先访问 `/health`，再打开首页用「填入示例」测试真实下载。免费方案的浏览器使用时长和启动频率有限，遇到 429 时可以稍后再试。[Browser Run 免费限额](https://developers.cloudflare.com/browser-run/limits/)
