const camera = document.querySelector('#camera');
const canvas = document.querySelector('#captureCanvas');
const openCameraBtn = document.querySelector('#openCameraBtn');
const captureBtn = document.querySelector('#captureBtn');
const imageInput = document.querySelector('#imageInput');
const recognizedText = document.querySelector('#recognizedText');
const speakBtn = document.querySelector('#speakBtn');
const pauseBtn = document.querySelector('#pauseBtn');
const resumeBtn = document.querySelector('#resumeBtn');
const stopBtn = document.querySelector('#stopBtn');
const clearBtn = document.querySelector('#clearBtn');
const rateInput = document.querySelector('#rateInput');
const rateValue = document.querySelector('#rateValue');
const languageSelect = document.querySelector('#languageSelect');
const autoSpeakToggle = document.querySelector('#autoSpeakToggle');
const statusBadge = document.querySelector('#statusBadge');
const cameraHint = document.querySelector('#cameraHint');
const progressWrap = document.querySelector('#progressWrap');
const progressBar = document.querySelector('#progressBar');
const progressText = document.querySelector('#progressText');

let stream = null;
let currentUtterance = null;
let isRecognizing = false;

function setStatus(text, type = '') {
  statusBadge.textContent = text;
  statusBadge.className = `badge ${type}`.trim();
}

function updateSpeechButtons() {
  const hasText = recognizedText.value.trim().length > 0;
  speakBtn.disabled = !hasText;
  pauseBtn.disabled = !speechSynthesis.speaking;
  resumeBtn.disabled = !speechSynthesis.paused;
  stopBtn.disabled = !speechSynthesis.speaking && !speechSynthesis.paused;
}

async function openCamera() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头访问');
    }
    stream?.getTracks().forEach(track => track.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });
    camera.srcObject = stream;
    await camera.play();
    captureBtn.disabled = false;
    cameraHint.textContent = '请将书页放入框内，保持稳定后点击识别';
    setStatus('摄像头已开启', 'active');
  } catch (error) {
    console.error(error);
    setStatus('摄像头失败', 'error');
    cameraHint.textContent = '无法打开摄像头，请检查 Safari 摄像头权限，或从相册选择图片';
    alert(`打开摄像头失败：${error.message}`);
  }
}

function captureVideoFrame() {
  if (!camera.videoWidth || !camera.videoHeight) {
    throw new Error('摄像头画面尚未准备好');
  }
  canvas.width = camera.videoWidth;
  canvas.height = camera.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(camera, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function recognizeImage(source) {
  if (isRecognizing) return;
  if (!window.Tesseract) {
    alert('文字识别组件加载失败，请检查网络后刷新页面。');
    return;
  }

  isRecognizing = true;
  captureBtn.disabled = true;
  imageInput.disabled = true;
  progressWrap.hidden = false;
  progressBar.style.width = '0%';
  progressText.textContent = '正在准备识别…';
  setStatus('正在识别', 'busy');

  try {
    const language = languageSelect.value;
    const result = await Tesseract.recognize(source, language, {
      logger(message) {
        if (message.status === 'recognizing text') {
          const percent = Math.round((message.progress || 0) * 100);
          progressBar.style.width = `${percent}%`;
          progressText.textContent = `正在识别 ${percent}%`;
        } else {
          progressText.textContent = '正在加载识别组件…';
        }
      }
    });

    const text = (result.data.text || '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new Error('没有识别到清晰文字');

    recognizedText.value = text;
    setStatus('识别完成', 'active');
    progressBar.style.width = '100%';
    progressText.textContent = '识别完成';
    updateSpeechButtons();

    if (autoSpeakToggle.checked) speakText();
  } catch (error) {
    console.error(error);
    setStatus('识别失败', 'error');
    progressText.textContent = error.message;
    alert(`识别失败：${error.message}。请重新拍摄，尽量保持光线均匀、书页平整。`);
  } finally {
    isRecognizing = false;
    captureBtn.disabled = !stream;
    imageInput.disabled = false;
  }
}

function chooseVoice(languageCode) {
  const voices = speechSynthesis.getVoices();
  const candidates = languageCode.startsWith('zh')
    ? voices.filter(v => /^zh/i.test(v.lang))
    : voices.filter(v => /^en/i.test(v.lang));
  return candidates.find(v => /Ting|Mei|Siri|Google|Microsoft/i.test(v.name)) || candidates[0] || null;
}

function speakText() {
  const text = recognizedText.value.trim();
  if (!text) return;

  speechSynthesis.cancel();
  currentUtterance = new SpeechSynthesisUtterance(text);
  currentUtterance.lang = languageSelect.value === 'eng' ? 'en-US' : 'zh-CN';
  currentUtterance.rate = Number(rateInput.value);
  const voice = chooseVoice(currentUtterance.lang);
  if (voice) currentUtterance.voice = voice;

  currentUtterance.onstart = () => {
    setStatus('正在朗读', 'active');
    updateSpeechButtons();
  };
  currentUtterance.onend = () => {
    setStatus('朗读完成', 'active');
    updateSpeechButtons();
  };
  currentUtterance.onerror = event => {
    console.error(event);
    setStatus('朗读失败', 'error');
    updateSpeechButtons();
  };

  speechSynthesis.speak(currentUtterance);
  updateSpeechButtons();
}

openCameraBtn.addEventListener('click', openCamera);
captureBtn.addEventListener('click', () => {
  try { recognizeImage(captureVideoFrame()); }
  catch (error) { alert(error.message); }
});

imageInput.addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) recognizeImage(file);
  event.target.value = '';
});

speakBtn.addEventListener('click', speakText);
pauseBtn.addEventListener('click', () => { speechSynthesis.pause(); updateSpeechButtons(); setStatus('已暂停', 'busy'); });
resumeBtn.addEventListener('click', () => { speechSynthesis.resume(); updateSpeechButtons(); setStatus('正在朗读', 'active'); });
stopBtn.addEventListener('click', () => { speechSynthesis.cancel(); updateSpeechButtons(); setStatus('已停止'); });
clearBtn.addEventListener('click', () => {
  speechSynthesis.cancel();
  recognizedText.value = '';
  progressWrap.hidden = true;
  setStatus(stream ? '摄像头已开启' : '未启动', stream ? 'active' : '');
  updateSpeechButtons();
});
recognizedText.addEventListener('input', updateSpeechButtons);
rateInput.addEventListener('input', () => { rateValue.textContent = Number(rateInput.value).toFixed(1); });

window.addEventListener('beforeunload', () => {
  stream?.getTracks().forEach(track => track.stop());
  speechSynthesis.cancel();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && speechSynthesis.speaking) speechSynthesis.pause();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.warn));
}

speechSynthesis.onvoiceschanged = () => {};
updateSpeechButtons();
