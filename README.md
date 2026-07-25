# 拍书朗读 PWA

一个面向 iPhone Safari 的 H5/PWA 原型：调用摄像头或相册，使用 OCR 识别书页文字，并自动语音朗读。

## 功能

- iPhone 后置摄像头拍摄
- 相册选择图片
- 中文/英文 OCR
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
- OCR：Tesseract.js 5（CDN）
- 朗读：Web Speech API / `speechSynthesis`
- PWA：Manifest + Service Worker

## 当前限制

- 首次 OCR 需要联网加载 Tesseract.js 和语言模型。
- 复杂排版、数学公式、竖排文字的准确率有限。
- iOS Safari 出于系统限制，页面切到后台后朗读可能暂停。
- 自动连续翻页识别尚未加入，本版采用手动拍照以保证稳定。
