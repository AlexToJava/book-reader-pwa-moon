# 拍书朗读 PWA

一个面向 iPhone Safari 的 H5/PWA 原型：调用摄像头或相册，使用 OCR 识别书页文字，并自动语音朗读。

## 功能

- iPhone 后置摄像头拍摄
- 相册选择图片
- **仅识别中文汉字**（字母、数字、英文符号自动过滤）
- 识别后自动朗读
- 暂停、继续、停止、重新朗读
- 调整语速
- 添加到 iPhone 主屏幕

## 本地运行

摄像头能力要求 HTTPS；电脑本地调试时 `localhost` 也可以。

```bash
cd book-reader-pwa
python3 -m http.server 8080
```

电脑浏览器访问：

```text
http://localhost:8080
```

若要在 iPhone 上测试，推荐部署到 Vercel、Netlify、Cloudflare Pages 或自己的 HTTPS 网站。不能直接双击 `index.html` 测试摄像头。

## iPhone 使用

1. 使用 Safari 打开 HTTPS 地址。
2. 点击“打开摄像头”，允许摄像头权限。
3. 对准书页，点击“拍照识别并朗读”。
4. 可在 Safari 分享菜单选择“添加到主屏幕”。

## 技术说明

- 摄像头：`navigator.mediaDevices.getUserMedia`
- OCR：Tesseract.js 5（CDN：jsDelivr 主源 + unpkg 回退）
- 朗读：Web Speech API / `speechSynthesis`
- PWA：Manifest + Service Worker（分层缓存，语言包可被离线缓存）

## 性能优化（已落地）

针对「识别慢、几分钟无结果」做了以下优化，识别耗时从数分钟降至数秒级：

1. **移除超大字符白名单**：早期把 2 万+ 汉字全部塞进 `tessedit_char_whitelist`，
   Tesseract 需对每个字符与整个名单逐一打分，是识别卡死的首要原因。
   现改为识别后用 `filterChineseOnly()` 过滤非中文，既提速又不影响中文准确率。
2. **限制图片尺寸**：OCR 输入上限由 3600px 降到 1600px，小图适度放大到 1200px，
   避免上千万像素拖垮识别。
3. **页面分割模式 PSM 3 → 6**：跳过方向/语言检测（OSD），对整齐书页更快。
4. **图片预处理管线**：灰度 → 高斯去噪 → Otsu 自动阈值二值化 → 断笔修复，
   提升小字号、低对比度书页的识别率。
5. **空闲预热引擎**：页面加载空闲时后台预下载中文语言包（Service Worker 缓存），
   首次拍照即可直接识别，无需现场等待下载。
6. **三阶段进度提示**：`步骤 1/3 预处理 → 步骤 2/3 加载/下载引擎 → 步骤 3/3 识别文字`，
   进度条映射到各阶段合理区间，并实时显示语言包下载百分比，避免「一直没动静」的错觉。

## 当前限制

- 首次 OCR 需联网下载 Tesseract.js 与中文语言包（约 15MB），之后由 Service Worker 缓存离线可用。
- 复杂排版、数学公式、竖排文字的准确率有限。
- iOS Safari 出于系统限制，页面切到后台后朗读可能暂停。
- 自动连续翻页识别尚未加入，本版采用手动拍照以保证稳定。
