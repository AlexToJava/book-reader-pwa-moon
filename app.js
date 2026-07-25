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
let ocrReady = false;       // 识别引擎是否已加载就绪（用于提示首次下载）
let warmupToastShown = false; // 预热成功提示是否已弹出（仅一次）

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

// ---- 识别进度阶段提示（步骤 N/3 + 进度条映射到合理区间） ----
function updateStage(stage, text, barPct) {
  DOM.progressText.textContent = `步骤 ${stage}/3 · ${text}`;
  if (typeof barPct === 'number') {
    const pct = Math.min(100, Math.round(barPct));
    DOM.progressBar.style.width = `${pct}%`;
    DOM.progressWrap.setAttribute('aria-valuenow', pct);
  }
}

// ---- 朗读按钮状态 ----
function updateSpeechButtons() {
  const hasText = DOM.recognizedText.value.trim().length > 0;
  DOM.speakBtn.disabled = !hasText || isSpeaking;
  DOM.pauseBtn.disabled = !speechSynthesis.speaking;
  DOM.resumeBtn.disabled = !speechSynthesis.paused;
  DOM.stopBtn.disabled = !speechSynthesis.speaking && !speechSynthesis.paused;
}

// ---- 图片预处理：透视矫正 → 光照归一化 → 自适应二值化 → 断笔修复 ----
// 参考「拍照识字」类 App（豆包 / 扫描全能王）的预处理思路：
// 1) 自动裁边 + 透视矫正：书页照片几乎都有梯形/倾斜畸变，是拍书识别率低的首要原因
// 2) 阴影/光照归一化：消除书脊阴影、不均匀打光（全局 Otsu 在阴影下会失效）
// 3) Sauvola 自适应二值化：对不均匀光照比全局 Otsu 鲁棒得多
// 4) 去噪 + 断笔修复 + 适度超分（保证小字号 DPI）
// 透视矫正带严格校验：检测不到清晰四边形就跳过，绝不会把图「矫正坏」
function preprocessImage(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        let w = img.width;
        let h = img.height;

        // 限制尺寸：OCR 在 1600px 级别已足够识别书页，过大只会拖慢速度
        // 小图适度放大到 1200，保证小字号也有足够 DPI
        let scale = 1;
        const minDim = Math.min(w, h);
        if (minDim < 900) scale = Math.min(2.0, 1200 / minDim);
        const maxDim = 1600;
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

        // 1) 转灰度（供后续处理）
        const gray0 = new Float32Array(n);
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
          gray0[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }

        // 2) 透视矫正（自动裁边 + 拉平书页）
        let cw = w, ch = h, cdata = data;
        const quad = detectDocumentQuad(gray0, w, h);
        if (quad) {
          const tw = Math.max(
            2,
            Math.round((dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2)
          );
          const th = Math.max(
            2,
            Math.round((dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2)
          );
          const warped = warpImageData(data, w, h, quad, tw, th);
          if (warped) {
            cw = tw;
            ch = th;
            cdata = warped;
          }
        }

        // 3) 用矫正后的图重新取灰度
        const gray = new Float32Array(cw * ch);
        for (let p = 0; p < cw * ch; p++) {
          gray[p] =
            0.299 * cdata[p * 4] + 0.587 * cdata[p * 4 + 1] + 0.114 * cdata[p * 4 + 2];
        }

        // 4) 光照/阴影归一化（消除书脊阴影、渐变打光）
        illuminationNormalize(gray, cw, ch);

        // 5) 轻微高斯去噪，让文字边缘干净
        const denoised = gaussianBlur(gray, cw, ch);

        // 6) Sauvola 自适应二值化（比全局 Otsu 更抗不均匀光照）
        const bin = sauovolaBinarize(denoised, cw, ch, 15, 0.34, 128);

        // 7) 膨胀连接断笔
        dilate(bin, cw, ch, 1);

        // 写回：黑字白底（Tesseract 偏好）
        const out = new Uint8ClampedArray(cw * ch * 4);
        for (let p = 0; p < cw * ch; p++) {
          const v = bin[p] ? 0 : 255;
          out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = v;
          out[p * 4 + 3] = 255;
        }
        DOM.canvas.width = cw;
        DOM.canvas.height = ch;
        ctx.putImageData(new ImageData(out, cw, ch), 0, 0);
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

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// 在缩小灰度图上检测书页四边形，返回 [{x,y}x4]（顺序 TL,TR,BR,BL，原图坐标），失败返回 null
function detectDocumentQuad(gray, w, h) {
  // 缩小到最长边 <= 480 以加速检测
  const maxSide = 480;
  const f = Math.min(1, maxSide / Math.max(w, h));
  const sw = Math.max(2, Math.round(w * f));
  const sh = Math.max(2, Math.round(h * f));
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      small[y * sw + x] = gray[Math.round(y / f) * w + Math.round(x / f)];
    }
  }
  // 边缘：模糊 + Sobel 幅值
  const blurred = gaussianBlur(small, sw, sh);
  const mag = new Float32Array(sw * sh);
  let maxM = 0;
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const gx = blurred[y * sw + (x + 1)] - blurred[y * sw + (x - 1)];
      const gy = blurred[(y + 1) * sw + x] - blurred[(y - 1) * sw + x];
      const m = Math.hypot(gx, gy);
      mag[y * sw + x] = m;
      if (m > maxM) maxM = m;
    }
  }
  const edge = new Uint8Array(sw * sh);
  const tEdge = maxM * 0.22;
  for (let i = 0; i < sw * sh; i++) edge[i] = mag[i] > tEdge ? 1 : 0;

  const lines = houghLines(edge, sw, sh);
  if (lines.length < 4) return null;
  const quad = selectBoundary(lines, sw, sh);
  if (!quad) return null;
  // 还原到原图坐标
  return quad.map((p) => ({ x: p.x / f, y: p.y / f }));
}

// 标准霍夫变换检测直线，返回 {t, rho, votes} 列表（按票数降序，截断前若干）
function houghLines(edge, w, h) {
  const step = Math.PI / 90; // 2°
  const thetas = [];
  for (let t = 0; t < Math.PI; t += step) thetas.push(t);
  const diag = Math.ceil(Math.hypot(w, h));
  const numRho = diag * 2 + 1;
  const acc = new Float32Array(thetas.length * numRho);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!edge[y * w + x]) continue;
      for (let ti = 0; ti < thetas.length; ti++) {
        const t = thetas[ti];
        const rho = Math.round(x * Math.cos(t) + y * Math.sin(t)) + diag;
        if (rho < 0 || rho >= numRho) continue;
        acc[ti * numRho + rho] += 1;
      }
    }
  }
  const thresh = Math.max(6, w * 0.12);
  const lines = [];
  for (let ti = 0; ti < thetas.length; ti++) {
    for (let ri = 0; ri < numRho; ri++) {
      const v = acc[ti * numRho + ri];
      if (v >= thresh) lines.push({ t: thetas[ti], rho: ri - diag, votes: v });
    }
  }
  lines.sort((a, b) => b.votes - a.votes);
  return lines.slice(0, 40);
}

// 从候选直线中选出 上下左右 四条边界，求交点得到四角；带严格校验
function selectBoundary(lines, w, h) {
  const vert = [];
  const horiz = [];
  for (const ln of lines) {
    if (ln.t < 0.25 || ln.t > Math.PI - 0.25) vert.push(ln); // 近垂直
    else if (Math.abs(ln.t - Math.PI / 2) < 0.25) horiz.push(ln); // 近水平
  }
  if (vert.length < 2 || horiz.length < 2) return null;
  const xAtMid = (ln) => (ln.rho - (h / 2) * Math.sin(ln.t)) / Math.cos(ln.t);
  const yAtMid = (ln) => (ln.rho - (w / 2) * Math.cos(ln.t)) / Math.sin(ln.t);
  vert.sort((a, b) => xAtMid(a) - xAtMid(b));
  horiz.sort((a, b) => yAtMid(a) - yAtMid(b));
  const left = vert[0];
  const right = vert[vert.length - 1];
  const top = horiz[0];
  const bottom = horiz[horiz.length - 1];
  const inter = (l1, l2) => {
    const a1 = Math.cos(l1.t), b1 = Math.sin(l1.t), c1 = -l1.rho;
    const a2 = Math.cos(l2.t), b2 = Math.sin(l2.t), c2 = -l2.rho;
    const det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 1e-6) return null;
    return { x: (b1 * c2 - b2 * c1) / det, y: (a2 * c1 - a1 * c2) / det };
  };
  const TL = inter(left, top);
  const TR = inter(right, top);
  const BR = inter(right, bottom);
  const BL = inter(left, bottom);
  if (!TL || !TR || !BR || !BL) return null;
  const m = 6;
  const inB = (p) => p.x >= m && p.x <= w - m && p.y >= m && p.y <= h - m;
  if (!(inB(TL) && inB(TR) && inB(BR) && inB(BL))) return null;
  // 面积至少占画面 30%，且角点顺序合理
  const area = Math.abs((TR.x - TL.x) * (BL.y - TL.y) - (BL.x - TL.x) * (TR.y - TL.y));
  if (area < 0.3 * w * h) return null;
  if (!(TL.x < TR.x && BL.x < BR.x && TL.y < BL.y && TR.y < BR.y)) return null;
  return [TL, TR, BR, BL];
}

// 单应变换：把源四边形（TL,TR,BR,BL）矫正为目标矩形，双线性采样
function warpImageData(srcData, sw, sh, quad, outW, outH) {
  const dst = [
    { x: 0, y: 0 },
    { x: outW - 1, y: 0 },
    { x: outW - 1, y: outH - 1 },
    { x: 0, y: outH - 1 },
  ];
  const H = computeHomography(dst, quad); // dst -> src
  if (!H) return null;
  const [a, b, c, d, e, f, g, hh] = H;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const den = g * x + hh * y + 1;
      const sx = (a * x + b * y + c) / den;
      const sy = (d * x + e * y + f) / den;
      const o = (y * outW + x) * 4;
      if (sx < 0 || sx > sw - 1 || sy < 0 || sy > sh - 1) {
        out[o] = out[o + 1] = out[o + 2] = 255;
        out[o + 3] = 255;
        continue;
      }
      let x0 = Math.floor(sx), y0 = Math.floor(sy);
      let x1 = x0 + 1, y1 = y0 + 1;
      if (x1 > sw - 1) x1 = sw - 1;
      if (y1 > sh - 1) y1 = sh - 1;
      const fx = sx - x0, fy = sy - y0;
      for (let k = 0; k < 4; k++) {
        const v00 = srcData[(y0 * sw + x0) * 4 + k];
        const v10 = srcData[(y0 * sw + x1) * 4 + k];
        const v01 = srcData[(y1 * sw + x0) * 4 + k];
        const v11 = srcData[(y1 * sw + x1) * 4 + k];
        const top = v00 + (v10 - v00) * fx;
        const bot = v01 + (v11 - v01) * fx;
        out[o + k] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

// DLT 解 8 参数单应矩阵 H（目标 4 点 -> 源 4 点）
function computeHomography(dst, src) {
  const A = [];
  const B = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = [dst[i].x, dst[i].y];
    const [u, v] = [src[i].x, src[i].y];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    B.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    B.push(v);
  }
  return solve8x8(A, B);
}

function solve8x8(A, b) {
  const n = 8;
  const M = [];
  for (let i = 0; i < n; i++) {
    M[i] = A[i].slice();
    M[i].push(b[i]);
  }
  for (let col = 0; col < n; col++) {
    let piv = -1;
    for (let r = col; r < n; r++) {
      if (Math.abs(M[r][col]) > 1e-9) {
        piv = r;
        break;
      }
    }
    if (piv < 0) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const dv = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= dv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const fv = M[r][col];
      if (fv === 0) continue;
      for (let j = col; j <= n; j++) M[r][j] -= fv * M[col][j];
    }
  }
  return M.map((row) => row[n]);
}

// 光照/阴影归一化：估计低频光照 L，用 gray / L 抵消阴影与渐变打光
function illuminationNormalize(gray, w, h) {
  const f = 8;
  const sw = Math.max(1, Math.round(w / f));
  const sh = Math.max(1, Math.round(h / f));
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let s = 0;
      const x0 = x * f, y0 = y * f;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const xx = Math.min(w - 1, x0 + dx);
          const yy = Math.min(h - 1, y0 + dy);
          s += gray[yy * w + xx];
        }
      }
      small[y * sw + x] = s / (f * f);
    }
  }
  const L = gaussianBlur(small, sw, sh); // 进一步平滑出低频光照
  // 双线性放大回原尺寸，并做 gray / L 归一化
  let mean = 0;
  for (let p = 0; p < w * h; p++) mean += gray[p];
  mean /= w * h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = (x / f) * (sw - 1);
      const fx0 = gx - Math.floor(gx);
      const fy0 = y / f - Math.floor(y / f);
      const ix0 = Math.min(sw - 1, Math.floor(gx));
      const iy0 = Math.min(sh - 1, Math.floor(y / f));
      const ix1 = Math.min(sw - 1, ix0 + 1);
      const iy1 = Math.min(sh - 1, iy0 + 1);
      const l00 = L[iy0 * sw + ix0];
      const l10 = L[iy0 * sw + ix1];
      const l01 = L[iy1 * sw + ix0];
      const l11 = L[iy1 * sw + ix1];
      const lt = l00 + (l10 - l00) * fx0;
      const lb = l01 + (l11 - l01) * fx0;
      const lval = lt + (lb - lt) * fy0;
      const p = y * w + x;
      let v = (gray[p] / (lval + 1)) * mean; // 消除光照乘性分量
      if (v < 0) v = 0;
      else if (v > 255) v = 255;
      gray[p] = v;
    }
  }
}

// Sauvola 自适应二值化（基于积分图，O(n)）。返回 Uint8Array：1=文字(暗)
function sauovolaBinarize(gray, w, h, winR, k, R) {
  const sum = new Float64Array((w + 1) * (h + 1));
  const sumSq = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rs2 = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      rs += v;
      rs2 += v * v;
      sum[(y + 1) * (w + 1) + (x + 1)] = sum[y * (w + 1) + (x + 1)] + rs;
      sumSq[(y + 1) * (w + 1) + (x + 1)] = sumSq[y * (w + 1) + (x + 1)] + rs2;
    }
  }
  const at = (arr, x, y) => arr[y * (w + 1) + x];
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - winR), y1 = Math.min(h - 1, y + winR);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - winR), x1 = Math.min(w - 1, x + winR);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const s = at(sum, x1 + 1, y1 + 1) - at(sum, x0, y1 + 1) - at(sum, x1 + 1, y0) + at(sum, x0, y0);
      const s2 = at(sumSq, x1 + 1, y1 + 1) - at(sumSq, x0, y1 + 1) - at(sumSq, x1 + 1, y0) + at(sumSq, x0, y0);
      const mean = s / area;
      const variance = s2 / area - mean * mean;
      const std = Math.sqrt(variance > 0 ? variance : 0);
      const T = mean * (1 + k * (std / R - 1));
      bin[y * w + x] = gray[y * w + x] < T ? 1 : 0;
    }
  }
  return bin;
}

// 3x3 可分离高斯模糊（用于去噪 / 光照估计）
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
      // PSM=6：假设整页是统一的文字块，跳过方向/语言检测，速度快很多；
      // 书页文字整齐，6 比 3（带 OSD）更合适也更快
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
      // 注意：不设置 tessedit_char_whitelist。
      // 之前把 2 万+ 汉字全塞进白名单，导致每个字符都要与整个名单打分，
      // 是「识别几分钟无结果」的首要原因。中文之外的字符已由 filterChineseOnly 过滤。
    });
    ocrReady = true; // 标记引擎已就绪，后续识别不再提示「首次下载」
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
  setStatus('正在识别', 'busy');
  updateStage(1, '预处理图片（透视矫正 / 去阴影 / 二值化）', 6);

  try {
    // 预处理图片以提高 OCR 准确率（灰度→去噪→二值化→断笔修复）
    const processed = await preprocessImage(source);
    updateStage(
      2,
      '加载识别引擎' + (ocrReady ? '' : '（首次需下载中文语言包，请稍候）'),
      18
    );

    // 进度回调【必须在 createOcrWorker 之前赋值】，否则语言包下载阶段的
    // 进度会整段丢失，用户看到「一直没动静」正是这个原因。
    ocrProgressCb = (message) => {
      const p = message.progress || 0;
      switch (message.status) {
        case 'loading tesseract core':
        case 'initializing tesseract':
          updateStage(2, '加载识别核心…', 22);
          break;
        case 'loading language traineddata':
          // 下载语言包：进度映射到 22% → 45%
          updateStage(
            2,
            '下载中文语言包 ' + Math.round(p * 100) + '%（首次较慢，已缓存后秒开）',
            22 + p * 23
          );
          break;
        case 'initializing api':
          updateStage(2, '初始化识别引擎…', 46);
          break;
        case 'recognizing text':
          // 识别阶段：进度映射到 48% → 100%
          updateStage(3, '正在识别中文 ' + Math.round(p * 100) + '%', 48 + p * 52);
          break;
        default:
          DOM.progressText.textContent = '正在处理: ' + message.status;
      }
    };

    // 复用预加载 worker（PSM=6，无超大白名单），提升速度
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

// ---- 空闲时预热识别引擎 ----
// 提前把中文语言包下载并缓存（Service Worker 会缓存 OCR 数据），
// 这样用户真正拍照时无需等待下载，识别几乎立即可开始。
function warmUpOcr() {
  if (!window.Tesseract || !navigator.onLine) return;
  createOcrWorker()
    .then(() => {
      console.log('OCR 引擎已预热');
      // 仅首次预热成功后提示一次，告知用户已可快速识别
      if (!warmupToastShown) {
        warmupToastShown = true;
        toast('识别引擎已就绪，可快速识别');
      }
    })
    .catch(() => { ocrWorkerPromise = null; }); // 失败不阻塞，下次识别再试
}
window.addEventListener('load', () => {
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 2000));
  idle(warmUpOcr);
});

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
