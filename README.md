# 口袋记账 v2

离线可用的个人记账 PWA。数据存在本机 IndexedDB，不依赖任何在线库。

## 部署（必须 HTTPS，否则无法离线 / 加密 / 添加到主屏幕）
把整个文件夹上传到任意静态托管即可（免费）：GitHub Pages、Cloudflare Pages、Netlify。
本地试用：`python3 -m http.server 8000`，浏览器打开 http://localhost:8000

## iPhone 使用
1. 用 Safari 打开网址 → 分享 → 添加到主屏幕。
2. **主屏幕版和 Safari 网页版的数据是分开的**：先在旧版导出备份，再在主屏幕版「更多 → 导入备份」。
3. 旧版（localStorage）数据：如果新版和旧版在同一个网址下，首次打开会自动迁移；否则用旧版的「导出完整备份」，新版直接导入（支持旧格式）。

## 更新版本
改动任何文件后，把 `sw.js` 里的 `VERSION` 加一，用户下次打开自动更新。

## 文件
- `index.html` / `styles.css`：页面与样式（CSP 限制：只允许本站脚本，禁止内联脚本与外部资源）
- `js/db.js`：IndexedDB 数据层（唯一 id、事务、回收站）
- `js/backup.js`：校验、备份、AES-256-GCM 加密、快照、旧版转换
- `js/charts.js`：Canvas 图表（替代 Chart.js）
- `js/app.js`：界面与功能
- `sw.js` / `manifest.webmanifest` / `icons/`：离线与主屏幕
