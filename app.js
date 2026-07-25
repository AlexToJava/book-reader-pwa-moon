/* ================================================================
   拍书朗读 PWA - 主逻辑
   ================================================================ */

const DOM = {
  camera: document.querySelector('#camera'),
  canvas: document.querySelector('#captureCanvas'),
  openCameraBtn: document.querySelector('#openCameraBtn'),
  captureBtn: document.querySelector('#captureBtn'),
  imageInput: document.querySelector('#imageInput'),
  recognizedText: document.querySelector('#recognizedText'),
  speakBtn: document.querySelector('#speakBtn'),
  pauseBtn: document.querySelector('#pauseBtn'),
  resumeBtn: document.querySelector('#resumeBtn'),
  stopBtn: document.querySelector('#stopBtn'),
  clearBtn: document.querySelector('#clearBtn'),
  rateInput: document.querySelector('#rateInput'),
  rateValue: document.querySelector('#rateValue'),
  languageSelect: document.querySelector('#languageSelect'),
  autoSpeakToggle: document.querySelector('#autoSpeakToggle'),
  statusBadge: document.querySelector('#statusBadge'),
  cameraHint: document.querySelector('#cameraHint'),
  progressWrap: document.querySelector('#progressWrap'),
  progressBar: document.querySelector('#progressBar'),
  progressText: document.querySelector('#progressText'),
  toast: document.querySelector('#toast'),
  toastMsg: document.querySelector('#toastMsg'),
  offlineBanner: document.querySelector('#offlineBanner'),
};

// ---- 状态 ----
let stream = null;
let isRecognizing = false;
let isSpeaking = false;
let speakQueue = [];        // 长文本分块队列
let currentChunkIndex = 0;
let toastTimer = null;
let voiceCache = null;      // 缓存匹配到的语音

// ---- Toast ----
function toast(message, duration = 3000) {
  clearTimeout(toastTimer);
  DOM.toastMsg.textContent = message;
  DOM.toast.classList.add('visible');
  toastTimer = setTimeout(() => DOM.toast.classList.remove('visible'), duration);
}

// ---- 状态徽章 ----
function setStatus(text, type = '') {
  DOM.statusBadge.textContent = text;
  DOM.statusBadge.className = `badge ${type}`.trim();
}

// ---- 朗读按钮状态 ----
function updateSpeechButtons() {
  const hasText = DOM.recognizedText.value.trim().length > 0;
  DOM.speakBtn.disabled = !hasText || isSpeaking;
  DOM.pauseBtn.disabled = !speechSynthesis.speaking;
  DOM.resumeBtn.disabled = !speechSynthesis.paused;
  DOM.stopBtn.disabled = !speechSynthesis.speaking && !speechSynthesis.paused;
}

// ---- 图片预处理：灰度 → 高斯去噪 → Otsu 二值化 → 断笔修复 ----
// 这套管线对笔画密集的中文识别率提升明显
function preprocessImage(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        let w = img.width;
        let h = img.height;

        // 小图放大（Tesseract 需要足够 DPI），超大图限制上限避免卡死
        let scale = 1;
        const minDim = Math.min(w, h);
        if (minDim < 1100) scale = Math.min(2.2, 1300 / minDim);
        const maxDim = 3600;
        if (Math.max(w, h) * scale > maxDim) {
          scale *= maxDim / (Math.max(w, h) * scale);
        }
        w = Math.round(w * scale);
        h = Math.round(h * scale);

        DOM.canvas.width = w;
        DOM.canvas.height = h;
        const ctx = DOM.canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);

        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;
        const n = w * h;

        // 1) 转灰度
        const gray = new Float32Array(n);
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
          gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }

        // 2) 高斯模糊去噪（让文字边缘干净）
        const blurred = gaussianBlur(gray, w, h);

        // 3) Otsu 自动阈值二值化
        const t = otsuThreshold(blurred, n);

        // 4) 二值化 + 轻微膨胀，连接断笔
        const bin = new Uint8Array(n);
        for (let p = 0; p < n; p++) bin[p] = blurred[p] > t ? 1 : 0;
        dilate(bin, w, h, 1);

        // 写回：黑字白底（Tesseract 偏好）
        for (let p = 0; p < n; p++) {
          const v = bin[p] ? 0 : 255;
          data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = v;
          data[p * 4 + 3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);
        resolve(DOM.canvas);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = reject;

    if (source instanceof HTMLCanvasElement) {
      img.src = source.toDataURL('image/jpeg', 0.92);
    } else if (source instanceof File || source instanceof Blob) {
      img.src = URL.createObjectURL(source);
    } else {
      resolve(source); // fallback
    }
  });
}

// 3x3 可分离高斯模糊（用于去噪）
function gaussianBlur(src, w, h) {
  const k = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const ksum = 16;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        acc += src[y * w + xx] * k[dx + 1 + 3];
      }
      tmp[y * w + x] = acc / ksum;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        acc += tmp[yy * w + x] * k[1 + (dy + 1) * 3];
      }
      out[y * w + x] = acc / ksum;
    }
  }
  return out;
}

// Otsu 最大类间方差法求二值化阈值
function otsuThreshold(gray, n) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) {
    let v = gray[i] | 0;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    hist[v]++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let maxVar = 0;
  let threshold = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

// 二值图像膨胀（radius=1），连接笔画断裂
function dilate(bin, w, h, r) {
  const copy = bin.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let val = 0;
      for (let dy = -r; dy <= r && !val; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          if (copy[yy * w + xx]) {
            val = 1;
            break;
          }
        }
      }
      bin[y * w + x] = val;
    }
  }
}

// 中文白名单：限制 Tesseract 只输出 CJK 汉字 + 中文标点，
// 从根本上避免把汉字误认成字母/数字/符号（准确率关键）
let _cnWhitelist = null;
function getChineseWhitelist() {
  if (_cnWhitelist) return _cnWhitelist;
  let s = '';
  const add = (a, b) => {
    for (let c = a; c <= b; c++) s += String.fromCharCode(c);
  };
  add(0x4e00, 0x9fff); // CJK 统一汉字（约 2 万常用字）
  add(0x3400, 0x4dbf); // 扩展 A（生僻字）
  add(0x3000, 0x303f); // CJK 标点（含 。“”‘’（）《》【】「」『』… 等）
  // 额外补全常用中文/全角标点（避免引号转义问题，仅用非 ASCII 引号字符）
  s += '。！？、；：，（）《》【】〈〉「」『』…—·～';
  _cnWhitelist = s;
  return s;
}

// 复用的识别 Worker（首次加载后缓存，加快后续识别）
let ocrWorkerPromise = null;
let ocrProgressCb = null;

function createOcrWorker() {
  if (ocrWorkerPromise) return ocrWorkerPromise;
  ocrWorkerPromise = (async () => {
    const worker = await Tesseract.createWorker('chi_sim', 1, {
      logger: (m) => {
        if (ocrProgressCb) ocrProgressCb(m);
      },
    });
    await worker.setParameters({
      tessedit_pageseg_mode: '3', // 自动页面分割（适合书页）
      preserve_interword_spaces: '1',
      tessedit_char_whitelist: getChineseWhitelist(),
    });
    return worker;
  })();
  return ocrWorkerPromise;
}

// ---- 摄像头 ----
async function openCamera() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头访问');
    }

    // 先关闭已有流
    stopStream();

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });

    DOM.camera.srcObject = stream;
    await DOM.camera.play();
    DOM.captureBtn.disabled = false;
    DOM.cameraHint.textContent = '请将书页放入框内，保持稳定后点击识别';
    setStatus('摄像头已开启', 'active');
  } catch (error) {
    console.error('摄像头错误:', error);
    setStatus('摄像头失败', 'error');
    DOM.cameraHint.textContent =
      '无法打开摄像头，请检查 Safari 摄像头权限，或从相册选择图片';
    toast(error.message || '打开摄像头失败');
  }
}

function stopStream() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
}

// ---- 拍照 ----
function captureVideoFrame() {
  if (!DOM.camera.videoWidth || !DOM.camera.videoHeight) {
    throw new Error('摄像头画面尚未准备好');
  }
  DOM.canvas.width = DOM.camera.videoWidth;
  DOM.canvas.height = DOM.camera.videoHeight;
  const ctx = DOM.canvas.getContext('2d');
  ctx.drawImage(DOM.camera, 0, 0, DOM.canvas.width, DOM.canvas.height);
  return DOM.canvas;
}

// ---- 中文过滤：只保留汉字 + 中文标点 + 换行 ----
// Unicode 范围：
//   \u4e00-\u9fff   CJK 统一汉字（常用汉字）
//   \u3400-\u4dbf   CJK 扩展A（生僻字）
//   \u20000-\u2a6df CJK 扩展B（生僻字，需代理对处理）
function filterChineseOnly(text) {
  // 中文标点白名单（用 codePoint 判断，避免引号转义问题）
  const cnPunctCodes = new Set([
    0x3002, // 。
    0xff01, // ！
    0xff1f, // ？
    0x3001, // 、
    0xff1b, // ；
    0xff1a, // ：
    0x201c, 0x201d, // " "
    0x2018, 0x2019, // ' '
    0xff08, 0xff09, // （ ）
    0x300a, 0x300b, // 《 》
    0x3010, 0x3011, // 【 】
    0x3008, 0x3009, // 〈 〉
    0x300c, 0x300d, // 「 」
    0x300e, 0x300f, // 『 』
    0x2026, // …
    0x2014, // —
    0x00b7, // ·
    0xff5e, // ～
  ]);

  const result = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    // 常用汉字 + 扩展A + 扩展B-E（代理对范围）
    const isCJK =
      (code >= 0x4e00 && code <= 0x9fff) ||   // CJK 统一汉字
      (code >= 0x3400 && code <= 0x4dbf) ||   // CJK 扩展A
      (code >= 0x20000 && code <= 0x2a6df) || // CJK 扩展B
      (code >= 0x2a700 && code <= 0x2b73f) || // CJK 扩展C
      (code >= 0x2b740 && code <= 0x2b81f) || // CJK 扩展D
      (code >= 0x2b820 && code <= 0x2ceaf);   // CJK 扩展E
    // 换行符保留（用于分段）
    const isNewline = ch === '\n' || ch === '\r';
    // 空格保留（但后续会压缩多余空格）
    const isSpace = ch === ' ' || ch === '\u3000'; // 半角+全角空格

    if (isCJK || cnPunctCodes.has(code) || isNewline || isSpace) {
      result.push(ch);
    }
  }

  return result.join('')
    .replace(/[ \u3000]{2,}/g, ' ')    // 多个空格压缩为一个
    .replace(/ *\n */g, '\n')           // 去掉行首行尾空格
    .replace(/\n{3,}/g, '\n\n')         // 多个换行压缩为两个
    .trim();
}

// ---- OCR 识别（仅中文，带重试） ----
async function recognizeImage(source, retryCount = 0) {
  if (isRecognizing) return;
  if (!window.Tesseract) {
    toast('文字识别组件加载失败，请检查网络后刷新页面');
    return;
  }

  const MAX_RETRIES = 1;
  isRecognizing = true;
  DOM.captureBtn.disabled = true;
  DOM.imageInput.disabled = true;
  DOM.progressWrap.hidden = false;
  DOM.progressBar.style.width = '0%';
  DOM.progressText.textContent = '正在预处理图片…';
  setStatus('正在识别', 'busy');

  try {
    // 预处理图片以提高 OCR 准确率（灰度→去噪→二值化→断笔修复）
    const processed = await preprocessImage(source);
    DOM.progressText.textContent = '正在加载识别引擎…';

    // 进度回调（复用缓存 worker）
    ocrProgressCb = (message) => {
      const statusMap = {
        'loading tesseract core': '正在加载 Tesseract 核心…',
        'initializing tesseract': '正在初始化…',
        'loading language traineddata': '正在加载中文语言包…',
        'initializing api': '正在初始化 API…',
        'recognizing text': `正在识别中文 ${Math.round((message.progress || 0) * 100)}%`,
      };
      DOM.progressText.textContent = statusMap[message.status] || `正在处理: ${message.status}`;
      if (message.status === 'recognizing text') {
        DOM.progressBar.style.width = `${Math.round((message.progress || 0) * 100)}%`;
      }
    };

    // 使用预加载 worker（含中文白名单 + 自动分页），提升准确率与速度
    let worker;
    try {
      worker = await createOcrWorker();
    } catch (e) {
      ocrWorkerPromise = null; // 重建
      worker = await createOcrWorker();
    }
    const result = await worker.recognize(processed);

    // 原始识别文本 → 过滤为纯中文
    const rawText = result.data.text || '';
    let text = filterChineseOnly(rawText);

    if (!text) {
      // 过滤后为空，尝试重试一次（可能是图片模糊）
      if (retryCount < MAX_RETRIES) {
        DOM.progressText.textContent = '未识别到中文，正在重试…';
        return recognizeImage(processed, retryCount + 1);
      }
      throw new Error('没有识别到中文汉字，请尝试调整光线或角度后重新拍摄');
    }

    DOM.recognizedText.value = text;
    setStatus('识别完成', 'active');
    DOM.progressBar.style.width = '100%';
    DOM.progressText.textContent = `识别完成（共 ${text.replace(/\s/g, '').length} 字）`;
    updateSpeechButtons();

    if (DOM.autoSpeakToggle.checked) speakText();
  } catch (error) {
    console.error('识别错误:', error);
    setStatus('识别失败', 'error');
    DOM.progressText.textContent = error.message;
    toast(error.message || '识别失败，请重新拍摄');
  } finally {
    isRecognizing = false;
    DOM.captureBtn.disabled = !stream;
    DOM.imageInput.disabled = false;
    // 3 秒后隐藏进度条
    setTimeout(() => {
      if (!isRecognizing) DOM.progressWrap.hidden = true;
    }, 3000);
  }
}

// ---- 语音选择（处理 iOS Safari 异步加载） ----
function getVoicesAsync() {
  return new Promise((resolve) => {
    const voices = speechSynthesis.getVoices();
    if (voices.length > 0) {
      voiceCache = voices;
      resolve(voices);
    } else {
      // iOS Safari 异步加载语音
      const handler = () => {
        voiceCache = speechSynthesis.getVoices();
        speechSynthesis.removeEventListener('voiceschanged', handler);
        resolve(voiceCache);
      };
      speechSynthesis.addEventListener('voiceschanged', handler);
      // 设置超时兜底
      setTimeout(() => {
        speechSynthesis.removeEventListener('voiceschanged', handler);
        resolve(voiceCache || speechSynthesis.getVoices());
      }, 2000);
    }
  });
}

function chooseVoice(languageCode) {
  const voices = voiceCache && voiceCache.length ? voiceCache : speechSynthesis.getVoices();
  // 只匹配中文语音
  const candidates = voices.filter((v) => /^zh/i.test(v.lang));

  // 优先级：Ting-Ting > Mei-Jia > Siri > Google > Microsoft > 其他
  return (
    candidates.find((v) => /Ting|Mei/i.test(v.name)) ||
    candidates.find((v) => /Siri|Google|Microsoft/i.test(v.name)) ||
    candidates[0] ||
    null
  );
}

// ---- 长文本分块朗读 ----
const MAX_CHUNK_LENGTH = 200; // Web Speech API 单次朗读建议长度

function splitText(text) {
  // 按句子边界分割
  const sentences = text.match(/[^。！？.!?\n]+[。！？.!?\n]?/g) || [text];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length > MAX_CHUNK_LENGTH && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

async function speakText() {
  const text = DOM.recognizedText.value.trim();
  if (!text) return;

  // 停止当前朗读
  speechSynthesis.cancel();
  isSpeaking = true;
  speakQueue = splitText(text);
  currentChunkIndex = 0;
  updateSpeechButtons();

  // 预加载语音列表
  await getVoicesAsync();
  speakNextChunk();
}

function speakNextChunk() {
  if (currentChunkIndex >= speakQueue.length) {
    // 朗读完成
    isSpeaking = false;
    setStatus('朗读完成', 'active');
    updateSpeechButtons();
    return;
  }

  const chunk = speakQueue[currentChunkIndex];
  const utterance = new SpeechSynthesisUtterance(chunk);
  // 固定使用中文语音
  utterance.lang = 'zh-CN';
  utterance.rate = Number(DOM.rateInput.value);
  const voice = chooseVoice(utterance.lang);
  if (voice) utterance.voice = voice;

  utterance.onstart = () => {
    setStatus(`正在朗读 (${currentChunkIndex + 1}/${speakQueue.length})`, 'active');
    updateSpeechButtons();
  };

  utterance.onend = () => {
    currentChunkIndex++;
    if (currentChunkIndex < speakQueue.length) {
      // 段落之间短暂停顿
      setTimeout(speakNextChunk, 300);
    } else {
      isSpeaking = false;
      setStatus('朗读完成', 'active');
      updateSpeechButtons();
    }
  };

  utterance.onerror = (event) => {
    console.error('朗读错误:', event);
    // "interrupted" 错误通常在 cancel 时触发，可忽略
    if (event.error === 'interrupted') return;
    // 尝试跳到下一段
    currentChunkIndex++;
    if (currentChunkIndex < speakQueue.length) {
      setTimeout(speakNextChunk, 300);
    } else {
      isSpeaking = false;
      setStatus('朗读完成', 'active');
      updateSpeechButtons();
    }
  };

  speechSynthesis.speak(utterance);
  updateSpeechButtons();
}

// ---- 事件绑定 ----

// 打开摄像头
DOM.openCameraBtn.addEventListener('click', openCamera);

// 拍照识别
DOM.captureBtn.addEventListener('click', () => {
  try {
    recognizeImage(captureVideoFrame());
  } catch (error) {
    toast(error.message);
  }
});

// 相册选择
DOM.imageInput.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) recognizeImage(file);
  event.target.value = '';
});

// 朗读控制
DOM.speakBtn.addEventListener('click', speakText);

DOM.pauseBtn.addEventListener('click', () => {
  speechSynthesis.pause();
  updateSpeechButtons();
  setStatus('已暂停', 'busy');
});

DOM.resumeBtn.addEventListener('click', () => {
  speechSynthesis.resume();
  updateSpeechButtons();
  setStatus('正在朗读', 'active');
});

DOM.stopBtn.addEventListener('click', () => {
  speechSynthesis.cancel();
  isSpeaking = false;
  speakQueue = [];
  updateSpeechButtons();
  setStatus('已停止');
});

// 清空
DOM.clearBtn.addEventListener('click', () => {
  speechSynthesis.cancel();
  isSpeaking = false;
  speakQueue = [];
  DOM.recognizedText.value = '';
  DOM.progressWrap.hidden = true;
  setStatus(stream ? '摄像头已开启' : '未启动', stream ? 'active' : '');
  updateSpeechButtons();
});

// 文本变更时更新按钮
DOM.recognizedText.addEventListener('input', () => {
  if (!isSpeaking) updateSpeechButtons();
});

// 语速调节
DOM.rateInput.addEventListener('input', () => {
  DOM.rateValue.textContent = Number(DOM.rateInput.value).toFixed(1);
});

// ---- 生命周期 ----

// 页面卸载时清理资源
window.addEventListener('beforeunload', () => {
  stopStream();
  speechSynthesis.cancel();
});

// 页面切到后台时暂停朗读
document.addEventListener('visibilitychange', () => {
  if (document.hidden && speechSynthesis.speaking) {
    speechSynthesis.pause();
    setStatus('已暂停（后台）', 'busy');
  }
});

// Service Worker 注册
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () =>
    navigator.serviceWorker
      .register('./sw.js')
      .catch((err) => console.warn('SW 注册失败:', err))
  );
}

// 监听在线/离线状态
window.addEventListener('online', () => {
  if (DOM.offlineBanner) DOM.offlineBanner.hidden = true;
  toast('网络已恢复');
});
window.addEventListener('offline', () => {
  if (DOM.offlineBanner) DOM.offlineBanner.hidden = false;
  toast('您已离线，部分功能可能受限');
});

// 初始化离线状态
if (!navigator.onLine && DOM.offlineBanner) {
  DOM.offlineBanner.hidden = false;
}

// 初始化
updateSpeechButtons();
