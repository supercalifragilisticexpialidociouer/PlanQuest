'use strict';

/*
 * HRMonitor —— 摄像头测心率（rPPG）
 * 原理：面部皮肤微血管的血液容积随心跳变化，反射光强随之微变。
 * 取额头区域帧间绿色通道的细微波动，滤波后在 45~180bpm 频段找主频。
 * 全部计算在本地完成，视频不上传。
 */

class HRMonitor {
  constructor() {
    this.stream = null;
    this.video = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.running = false;
    this.samples = []; // { t, v }
    this.lastSampleT = 0;
    this.bpm = 0;
    this.quality = 0; // 0~1
    this.onUpdate = () => {};
    this._raf = null;
    this._fftN = 256;
    this._fs = 30; // 目标采样率
  }

  async start(videoEl) {
    this.video = videoEl;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: 'user' },
      audio: false,
    });
    videoEl.srcObject = this.stream;
    await videoEl.play();
    this.running = true;
    this.samples = [];
    this.bpm = 0;
    this.quality = 0;
    this._loop();
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.video) this.video.srcObject = null;
    this.stream = null;
    this.bpm = 0;
    this.quality = 0;
    this.onUpdate({ bpm: 0, quality: 0, wave: [] });
  }

  _loop() {
    if (!this.running) return;
    this._raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    if (now - this.lastSampleT < 1000 / this._fs - 2) return;
    this.lastSampleT = now;
    this._sample(now);
    this._analyze();
  }

  _sample(t) {
    const v = this.video;
    if (!v || v.readyState < 2) return;
    const w = 80;
    const h = 60;
    if (this.canvas.width !== w) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    // 取画面中上部（额头）区域
    const sx = (v.videoWidth - v.videoWidth * 0.3) / 2;
    const sy = v.videoHeight * 0.12;
    const sw = v.videoWidth * 0.3;
    const sh = v.videoHeight * 0.22;
    try {
      this.ctx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
    } catch (_) {
      return;
    }
    const d = this.ctx.getImageData(0, 0, w, h).data;
    let r = 0;
    let g = 0;
    let b = 0;
    const n = w * h;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    r /= n;
    g /= n;
    b /= n;
    // CHROM 色度信号：抑制光照/运动伪影
    const chrom = 3 * (g - (r + b) / 2) / Math.max(1, r + g + b);
    this.samples.push({ t, v: chrom });
    const cutoff = t - 16000;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
  }

  _analyze() {
    if (this.samples.length < this._fs * 8) {
      // 采集中，样本还不够
      this.onUpdate({ bpm: this.bpm, quality: this.quality, wave: this._wave(), warming: true });
      return;
    }
    // 1) 均匀重采样
    const N = this._fftN;
    const fs = this._fs;
    const recent = this.samples.slice(-N);
    if (recent.length < N) return;
    const t0 = recent[0].t;
    const sig = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const target = t0 + (i * 1000) / fs;
      // 最近邻
      let best = 0;
      let bd = Infinity;
      for (let j = 0; j < N; j++) {
        const d = Math.abs(recent[j].t - target);
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      sig[i] = recent[best].v;
    }

    // 2) 去趋势（减去滑动均值）
    const win = Math.floor(fs * 1.2);
    const detrended = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let sum = 0;
      let cnt = 0;
      for (let j = Math.max(0, i - win); j < Math.min(N, i + win); j++) {
        sum += sig[j];
        cnt++;
      }
      detrended[i] = sig[i] - sum / cnt;
    }

    // 3) 汉明窗 + FFT
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      re[i] = detrended[i] * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1)));
    }
    fft(re, im);

    // 4) 45~180bpm 频段找主频
    const loBin = Math.max(1, Math.floor((45 / 60) * N / fs));
    const hiBin = Math.min(N / 2 - 1, Math.ceil((180 / 60) * N / fs));
    let peakI = loBin;
    let peakP = 0;
    let total = 0;
    for (let i = loBin; i <= hiBin; i++) {
      const p = re[i] * re[i] + im[i] * im[i];
      total += p;
      if (p > peakP) {
        peakP = p;
        peakI = i;
      }
    }
    if (total <= 0) return;
    const bpm = Math.round(((peakI * fs) / N) * 60);
    const conf = peakP / total;

    // 平滑：与上次差距过大时，要求置信度更高才跳变
    if (!this.bpm || Math.abs(bpm - this.bpm) <= 8 || conf > 0.25) {
      this.bpm = Math.round(this.bpm * 0.6 + bpm * 0.4);
    }
    this.quality = Math.min(1, conf * 12);
    this.onUpdate({ bpm: this.bpm, quality: this.quality, wave: this._wave(detrended) });
  }

  _wave(buf) {
    const src = buf || null;
    const out = [];
    if (src) {
      const step = Math.max(1, Math.floor(src.length / 128));
      let max = 1e-6;
      for (let i = 0; i < src.length; i += step) max = Math.max(max, Math.abs(src[i]));
      for (let i = 0; i < src.length; i += step) out.push(src[i] / max);
    } else {
      // 用原始样本画实时波形
      const s = this.samples.slice(-160);
      let max = 1e-6;
      for (const p of s) max = Math.max(max, Math.abs(p.v));
      for (const p of s) out.push(p.v / max);
    }
    return out;
  }
}

/* 就地 FFT（迭代 radix-2） */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

window.HRMonitor = HRMonitor;
