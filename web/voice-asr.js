'use strict';
/* VoiceASR —— 本地语音转文字（Vosk 中文小模型，Apache-2.0）
 *
 * 用途：开麦时把你说的话在本地转成文字，交给「闲聊雷达」（AIChat）
 *       —— 与打字聊天同一分类器、同一扣分规则（5 分钟内 3 条闲聊 → 扣 2 分）。
 * 音频不出设备：识别在本机 WebAssembly 里完成，断网照常工作。
 *
 * 模型：vendor/asr/vosk-model-small-cn-0.22.zip（约 42 MB，开麦时才加载，只加载一次）
 * 运行时：vendor/asr/vosk.js（vosk-browser，内嵌 wasm，按需注入 <script>）
 * 加载：桌面 file:// 走 preload readVendorFile 读盘 → Blob URL；
 *      网页 / 安卓 WebView 直接 fetch 同目录文件 → Blob URL。
 *      统一用 Blob URL 是因为 worker 内 fetch blob: 不受 file:// 限制。
 */
const VoiceASR = (() => {
  const LIB = 'vendor/asr/vosk.js';
  const MODEL = 'vendor/asr/vosk-model-small-cn-0.22.zip';
  const DEDUP_MS = 20 * 1000;   // 同一句话 20 秒内不重复计
  const MIN_LEN = 2;            // 少于 2 个字的转写不判（“嗯”“啊”）
  const TAIL_FRAMES = 12;       // 说完话后补 12 帧静音尾巴（ScriptProcessor 4096@16k ≈ 1.6s）
  let silenceBuf = null;

  let libLoading = null;        // <script> 注入 promise
  let modelLoading = null;      // 模型加载 promise（只跑一次）
  let model = null;
  let rec = null;
  let ctx = null;
  let srcNode = null;
  let procNode = null;
  let attachedStream = null;
  let lastText = '';
  let lastAt = 0;
  let busy = false;
  let voicedTail = 0;

  function silenceFrame(len) {
    if (!silenceBuf || silenceBuf.length !== len) silenceBuf = new Float32Array(len);
    return silenceBuf;
  }

  function loadLib() {
    if (window.Vosk && window.Vosk.createModel) return Promise.resolve(window.Vosk);
    if (libLoading) return libLoading;
    libLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LIB;
      s.onload = () => (window.Vosk && window.Vosk.createModel
        ? resolve(window.Vosk)
        : reject(new Error('vosk.js 加载失败')));
      s.onerror = () => { libLoading = null; reject(new Error('vosk.js 404')); };
      document.head.appendChild(s);
    });
    return libLoading;
  }

  /* 桌面走 preload 读盘（省 42MB 走网络），其余 fetch；都转成 Blob URL */
  async function modelUrl() {
    const api = window.api;
    if (api && typeof api.readVendorFile === 'function') {
      const bytes = await api.readVendorFile(MODEL).catch(() => null);
      if (bytes && bytes.byteLength) return URL.createObjectURL(new Blob([bytes]));
    }
    const res = await fetch(MODEL);
    if (!res.ok) throw new Error('ASR 模型读取失败 (' + res.status + ')');
    return URL.createObjectURL(new Blob([await res.arrayBuffer()]));
  }

  function getModel() {
    if (model) return Promise.resolve(model);
    if (!modelLoading) {
      modelLoading = (async () => {
        const Vosk = await loadLib();
        const url = await modelUrl();
        /* 不用 Vosk.createModel：它出错时 reject(undefined) 且 'error' 事件没人听，
           失败原因会静默丢掉。直接用 Model + 明确的 load/error 监听。 */
        const m = new Vosk.Model(url, -1);
        const done = new Promise((resolve, reject) => {
          m.addEventListener('load', () => resolve(m));
          m.addEventListener('error', (e) =>
            reject(new Error('ASR 模型加载失败: ' + ((e && e.detail && e.detail.error) || '未知'))));
        });
        const ok = await done;
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        model = ok;
        return ok;
      })().catch((e) => { modelLoading = null; throw e; });
    }
    return modelLoading;
  }

  function emit(text, cb) {
    const now = Date.now();
    if (text === lastText && now - lastAt < DEDUP_MS) return;
    lastText = text;
    lastAt = now;
    try { cb(text); } catch (_) {}
  }

  /* 挂到一条麦克风流上；每句说完（静音判定）触发 onText(全文) */
  async function attach(stream, onText) {
    detach();
    if (!stream || !stream.getAudioTracks().length) return false;
    attachedStream = stream;
    const m = await getModel();
    if (attachedStream !== stream) return false; // attach 期间被 detach
    rec = new m.KaldiRecognizer(16000);
    rec.on('result', (e) => {
      const t = String((e && e.result && e.result.text) || '').trim();
      if (t.length >= MIN_LEN && onText) emit(t, onText);
    });
    /* 16k 单声道上下文（浏览器自动把 48k 麦克风重采样），能量门限省掉静音段 */
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    srcNode = ctx.createMediaStreamSource(stream);
    procNode = ctx.createScriptProcessor(4096, 1, 1);
    procNode.onaudioprocess = (e) => {
      if (!rec || busy) return;
      const frame = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < frame.length; i += 8) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / (frame.length / 8));
      if (rms < 0.004) {
        /* 静音不喂省 CPU，但刚说完话要补 ~1.6s 静音尾巴，让 Vosk 出最终结果 */
        if (voicedTail > 0) {
          voicedTail -= 1;
          busy = true;
          try { rec.acceptWaveformFloat(silenceFrame(frame.length), ctx.sampleRate); } catch (_) {}
          busy = false;
        }
        return;
      }
      voicedTail = TAIL_FRAMES;
      busy = true;
      try { rec.acceptWaveformFloat(frame, ctx.sampleRate); } catch (_) {}
      busy = false;
    };
    srcNode.connect(procNode);
    /* 不连 destination：避免回声；ScriptProcessor 需要一条输出线才会跑，连一个零增益节点 */
    const sink = ctx.createGain();
    sink.gain.value = 0;
    procNode.connect(sink);
    sink.connect(ctx.destination);
    return true;
  }

  function detach() {
    try { if (procNode) procNode.onaudioprocess = null; } catch (_) {}
    try { if (srcNode) srcNode.disconnect(); } catch (_) {}
    try { if (procNode) procNode.disconnect(); } catch (_) {}
    try { if (ctx) ctx.close(); } catch (_) {}
    ctx = srcNode = procNode = null;
    attachedStream = null;
    voicedTail = 0;
    if (rec) { try { rec.remove(); } catch (_) {} rec = null; }
  }

  return {
    attach,
    detach,
    ready: () => !!model,
    on: () => !!procNode,
    status: () => ({ loaded: !!model, listening: !!procNode }),
  };
})();
window.VoiceASR = VoiceASR;
