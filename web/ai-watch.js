'use strict';
/* AIWatch —— 房间 AI 盯学：用「摸鱼/认真」分类模型分析自己的摄像头画面
 *
 * 模型：mobilenet_v3_small（vendor/pq-ai/best.onnx，BSD-3 许可，替换原 YOLOv8 AGPL 模型），输入 224×224 NCHW float32 0~1，
 *      输出 [1,2] softmax，索引 0=摸鱼（睡觉/趴桌/玩手机/发呆），1=认真
 * 规则：每 5 秒分析一帧；摸鱼置信度 ≥ 0.6 记一次「摸鱼帧」，
 *      连续 2 次摸鱼帧 → 房间广播 + 扣 2 积分（允许扣成负分），连击清零。
 * 依赖：app.js 提供 camStream（共享摄像头 MediaStream）；api.aiPenalty 由各端扣分。
 * 加载：桌面 Electron（file://）禁止 fetch → 用内嵌 base64（window.__PQ_MODEL_B64 /
 *      __ORT_WASM_B64）；安卓 WebView / 网页（https）→ 直接 fetch 模型与 wasm。
 */
const AIWatch = (() => {
  const MODEL_URL = 'vendor/pq-ai/best.onnx';
  const INPUT_SIZE = 224; // 与 best.onnx（224 版）一致
  const EVERY_MS = 5000;   // 分析间隔
  const FISH_CONF = 0.6;   // 摸鱼置信度阈值
  const FISH_STREAK = 2;   // 连续摸鱼帧数 → 触发
  const PENALTY = 2;       // 每次触发扣分

  let ortSession = null;   // onnxruntime InferenceSession（只加载一次）
  let loading = null;      // 防并发加载
  let timer = null;
  let busy = false;
  let running = false;
  let getStream = null;    // () => MediaStream
  let video = null;
  let stats = null;
  let calib = null;        // 自训练校准：{ T, b }（把官方 logit 差重新映射成摸鱼概率）
  let lastShot = null;     // 最近一次判定：{ d, thumb, at }（给「刚才真在摸鱼吗」纠错用）
  let lastBroadcast = 0;   // 上次向房间广播「被抓包」的时间
  const BROADCAST_GAP = 3 * 60 * 1000; // 同一房间至少隔 3 分钟才再播报一次，避免刷屏被禁言

  function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }

  /* 异地联机页（net.html）没有 app.js 的 $ 与 toast，这里做兼容 */
  function qs(sel) {
    try {
      if (typeof $ === 'function') return $(sel);
    } catch (_) {}
    try {
      return document.querySelector(sel);
    } catch (_) {
      return null;
    }
  }
  function say(a, b, c) {
    try {
      if (typeof toast === 'function') toast(a, b, c);
    } catch (_) {}
  }

  function s() {
    return stats;
  }
  function isRunning() {
    return running;
  }

  /* base64 → Uint8Array（file:// 页面禁止 fetch，wasm 与模型都以 base64 内嵌加载） */
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /* 模型字节：桌面用内嵌 base64；安卓/网页用 fetch */
  async function loadModelBytes() {
    if (window.__PQ_MODEL_B64) {
      const bytes = b64ToBytes(window.__PQ_MODEL_B64);
      window.__PQ_MODEL_B64 = null; // 释放内存
      return bytes;
    }
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error('模型下载失败 ' + res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  async function ensureModel() {
    if (ortSession) return ortSession;
    if (loading) return loading;
    loading = (async () => {
      try {
        const ort = window.ort;
        if (!ort) throw new Error('onnxruntime 未加载');
        ort.env.wasm.proxy = false; // 主线程直接跑，免去 worker/跨域隔离要求
        ort.env.wasm.numThreads = 1;
        if (!ort.env.wasm.wasmBinary) {
          if (window.__ORT_WASM_B64) {
            ort.env.wasm.wasmBinary = b64ToBytes(window.__ORT_WASM_B64); // 桌面：内嵌
            window.__ORT_WASM_B64 = null;
          } else {
            ort.env.wasm.wasmPaths = './'; // 安卓/网页：ort 脚本同目录取 wasm
          }
        }
        const modelBytes = await loadModelBytes();
        if (!modelBytes) throw new Error('模型缺失');
        ortSession = await ort.InferenceSession.create(modelBytes, {
          executionProviders: ['wasm'],
        });
        return ortSession;
      } catch (err) {
        loading = null;
        throw err;
      }
    })();
    return loading;
  }

  /* 短边缩放 + 中心裁剪（与模型训练预处理一致），返回 {1,3,224,224} 张量 */
  function frameToTensor(srcW, srcH, draw) {
    const canvas = document.createElement('canvas');
    canvas.width = INPUT_SIZE;
    canvas.height = INPUT_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const side = Math.min(srcW, srcH);
    const sx = (srcW - side) / 2;
    const sy = (srcH - side) / 2;
    draw(ctx, sx, sy, side, side);
    const data = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data; // RGBA
    const planes = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
    const n = INPUT_SIZE * INPUT_SIZE;
    for (let i = 0; i < n; i++) {
      planes[i] = data[i * 4] / 255;
      planes[n + i] = data[i * 4 + 1] / 255;
      planes[2 * n + i] = data[i * 4 + 2] / 255;
    }
    return new window.ort.Tensor('float32', planes, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  }

  /* 给纠错用的缩略图（96×72 JPEG，约 2~4KB，只在内存里留最近一张） */
  function makeThumb() {
    try {
      if (!video || video.readyState < 2 || !video.videoWidth) return '';
      const w = 96;
      const h = 72;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      const side = Math.min(video.videoWidth, video.videoHeight);
      ctx.drawImage(
        video,
        (video.videoWidth - side) / 2,
        (video.videoHeight - side) / 2,
        side,
        side,
        0,
        0,
        w,
        h
      );
      return c.toDataURL('image/jpeg', 0.55);
    } catch (_) {
      return '';
    }
  }

  /* 分析一帧，返回 { fish, score, scores } 或 null */
  async function classify() {
    const stream = getStream && getStream();
    if (!stream || !stream.getVideoTracks().some((t) => t.readyState === 'live')) return null;
    if (!video) {
      video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
    }
    if (video.srcObject !== stream) video.srcObject = stream;
    try {
      if (video.readyState < 2) await video.play().catch(() => {});
    } catch (_) {}
    if (video.readyState < 2 || !video.videoWidth) return null;
    const session = await ensureModel();
    const input = frameToTensor(
      video.videoWidth,
      video.videoHeight,
      (ctx, sx, sy, sw, sh) => ctx.drawImage(video, sx, sy, sw, sh, 0, 0, INPUT_SIZE, INPUT_SIZE)
    );
    const out = await session.run({ images: input });
    const p = Array.from(out.output0.data); // [摸鱼, 认真]，已 softmax
    /* 由 softmax 反推 logit 差（数学上等价：ln p1 - ln p0 = z1 - z0），
       自训练校准作用在这一维上，不改模型本身 */
    const d = Math.log(Math.max(p[1], 1e-6)) - Math.log(Math.max(p[0], 1e-6));
    let fishScore = p[0];
    if (calib && calib.T > 0) fishScore = sigmoid(d / calib.T + calib.b);
    lastShot = { d, thumb: makeThumb(), at: Date.now() };
    return { fish: fishScore >= 0.5, fishScore, d, scores: { fish: p[0], good: p[1] } };
  }

  async function tick() {
    if (!running || busy) return;
    busy = true;
    let r = null;
    try {
      r = await classify();
    } catch (err) {
      console.warn('[AIWatch]', err);
      stop('模型加载失败：' + (err && err.message ? err.message.slice(0, 60) : '未知错误'), true);
      busy = false;
      return;
    }
    busy = false;
    if (!r) {
      paint();
      return;
    }
    if (r.fish && r.fishScore >= FISH_CONF) {
      stats.streak += 1;
      stats.fishFrames += 1;
    } else {
      stats.streak = 0;
      stats.goodFrames += 1;
    }
    stats.last = { fish: r.fish && r.fishScore >= FISH_CONF, score: r.fishScore, at: Date.now() };
    if (stats.streak >= FISH_STREAK) {
      stats.triggers += 1;
      stats.streak = 0;
      trigger();
    }
    paint();
  }

  function trigger() {
    const sec = Math.round(EVERY_MS * FISH_STREAK / 1000);
    /* 房间播报要节流：之前每 10 秒一条一模一样的「被抓包」，
       30 秒就被房主端判定成「连续重复发送相同内容」→ 自己把自己禁言了。
       现在 3 分钟内最多播一条，带上次数，内容不再重复。 */
    const now = Date.now();
    if (now - lastBroadcast >= BROADCAST_GAP) {
      lastBroadcast = now;
      const msg = `🤖 AI 盯学：检测到我在摸鱼 😴（第 ${stats.triggers} 次 · 已扣 ${stats.triggers * PENALTY} 积分）`;
      try {
        if (typeof window.pqSay === 'function') window.pqSay(msg);
        else if (typeof api !== 'undefined' && typeof api.roomChat === 'function' && typeof roomJoined !== 'undefined' && roomJoined) {
          api.roomChat(msg);
        }
      } catch (_) {}
    }
    say(`🤖 被抓包：摸鱼 ${sec} 秒`, `扣除 ${PENALTY} 积分 · 回到认真状态吧！`, true);
    /* 通知界面弹「刚才真在摸鱼吗」——回答会变成画面校准的训练样本 */
    try {
      if (typeof window.onAIWatched === 'function') window.onAIWatched();
    } catch (_) {}
    /* 扣分走主进程，允许扣成负分（与惩罚通道一致） */
    if (typeof api.aiPenalty === 'function') {
      api.aiPenalty(-PENALTY)
        .then((res) => {
          if (res && typeof res.points === 'number' && typeof state !== 'undefined' && state.profile) {
            state.profile.points = res.points;
          }
        })
        .catch(() => {});
    }
  }

  /* 状态写到房间 UI：按钮文案 + 状态条 + 自己摄像头画框颜色 */
  function paint() {
    const chip = qs('#ai-status');
    if (chip && stats) {
      if (stats.last && Date.now() - stats.last.at < 12000) {
        chip.className = 'ai-status ' + (stats.last.fish ? 'fish' : 'good');
        chip.textContent = stats.last.fish
          ? `😴 摸鱼 ${(stats.last.score * 100).toFixed(0)}% · 已抓包 ${stats.triggers} 次`
          : `📖 认真 ${(100 - stats.last.score * 100).toFixed(0)}% · 已抓包 ${stats.triggers} 次`;
      } else {
        chip.className = 'ai-status';
        chip.textContent = `🤖 盯学中 · 已抓包 ${stats.triggers} 次`;
      }
    }
    const tile = document.querySelector('.cam-tile[data-cam="self"]');
    if (tile) {
      tile.classList.toggle('ai-fish', !!(stats && stats.last && stats.last.fish && Date.now() - stats.last.at < 12000));
      tile.classList.toggle('ai-good', !!(stats && stats.last && !stats.last.fish && Date.now() - stats.last.at < 12000));
    }
    const b = qs('#ai-toggle');
    if (b) {
      b.textContent = running ? '⏹ 停止 AI 盯学' : '🤖 AI 盯学';
      b.classList.toggle('warm', running);
      b.classList.toggle('ghost', !running);
    }
  }

  function start(streamGetter) {
    if (running) return;
    if (typeof camOn !== 'undefined' && !camOn) {
      return say('先开摄像头', 'AI 盯学需要先开摄像头', true);
    }
    getStream = streamGetter || (() => null);
    stats = { streak: 0, fishFrames: 0, goodFrames: 0, triggers: 0, last: null };
    lastBroadcast = 0;
    running = true;
    paint();
    say('🤖 AI 盯学已开启', '每 5 秒检查一次画面，连续摸鱼会扣分', false);
    tick();
    timer = setInterval(tick, EVERY_MS);
  }

  function stop(reason, silent) {
    if (!running) return;
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (video) {
      try {
        video.srcObject = null;
      } catch (_) {}
    }
    const st = stats;
    stats = null;
    const tile = document.querySelector('.cam-tile[data-cam="self"]');
    if (tile) tile.classList.remove('ai-fish', 'ai-good');
    const chip = qs('#ai-status');
    if (chip) {
      chip.className = 'ai-status';
      chip.textContent = '';
    }
    const b = qs('#ai-toggle');
    if (b) {
      b.textContent = '🤖 AI 盯学';
      b.classList.remove('warm');
      b.classList.add('ghost');
    }
    if (!silent && st) {
      const lost = st.triggers * PENALTY;
      say(
        '🤖 AI 盯学结束',
        `认真 ${st.goodFrames} 帧 · 摸鱼 ${st.fishFrames} 帧 · 抓包 ${st.triggers} 次${lost ? ` · 共扣 ${lost} 分` : ''}`,
        lost > 0
      );
    } else if (reason && silent) {
      say('🤖 AI 盯学已停止', reason, true);
    }
  }

  /* 自训练：切校准参数（null 回官方）；lastShot 供「刚才真在摸鱼吗」取样本 */
  function setCalib(c) {
    calib = c && c.T > 0 ? { T: c.T, b: c.b || 0 } : null;
    lastShot = null;
  }
  function getShot() {
    return lastShot;
  }

  return { start, stop, isRunning, s, setCalib, getShot, calib: () => calib };
})();
window.AIWatch = AIWatch;
