'use strict';

/*
 * LiveKit 语音 glue（PC 渲染层与手机 WebView 共用）
 * - 门票来自房间协议（PC：room:event 的 livekit / roomStatus().livekit；手机：room.onRoom）
 * - 房主配置了 LiveKit 才有语音；没配置 = 房间照常，只是没有声音
 * - 不传视频（摄像头/屏幕共享仍走原 TCP 通道），先把语音做稳
 */
(function () {
  if (window.PQVoice) return;

  let room = null; // LiveKit Room
  let mic = null; // LocalAudioTrackPublication
  let muted = false;
  let connecting = false;
  let currentKey = ''; // url|token，防止重复连接
  const listeners = new Set();

  function notify() {
    const s = status();
    listeners.forEach((fn) => {
      try { fn(s); } catch (_) {}
    });
  }

  function status() {
    if (room) return { active: true, muted, connecting };
    return { active: false, muted, connecting };
  }

  function toastBad(msg) {
    try { if (typeof toast === 'function') toast(msg, '', true); } catch (_) {}
  }

  async function connect(info) {
    if (!info || !info.url || !info.token) return;
    const key = info.url + '|' + info.token;
    if (room || connecting) {
      currentKey = key; // 记住最新的票，等断开后重连
      if (room) return;
    }
    if (!window.LivekitClient || typeof LivekitClient.connect !== 'function') {
      toastBad('语音组件没加载，重进房间试试');
      return;
    }
    connecting = true;
    currentKey = key;
    notify();
    try {
      room = await LivekitClient.connect(info.url, info.token, {
        audio: true, // 进房即带麦克风
        video: false,
        autoSubscribe: true,
      });
      muted = false;
      try {
        const pubs = [...room.localParticipant.audioTrackPublications.values()];
        mic = pubs.length ? pubs[0] : null;
      } catch (_) { mic = null; }
      notify();
    } catch (e) {
      room = null;
      toastBad('语音连接失败：' + (e && e.message ? e.message : '稍后再试'));
    } finally {
      connecting = false;
      notify();
      // 连接期间拿到了更新的票（比如重连），接着上
      if (!room && currentKey && currentKey !== (info.url + '|' + info.token)) {
        const [u, t] = currentKey.split('|');
        connect({ url: u, token: t });
      }
    }
  }

  async function disconnect() {
    if (!room) return;
    const r = room;
    room = null;
    mic = null;
    currentKey = '';
    notify();
    try { await r.disconnect(); } catch (_) {}
  }

  async function toggleMic() {
    if (!room) return false;
    try {
      await room.localParticipant.setMicrophoneEnabled(muted);
      muted = !muted;
      notify();
      return true;
    } catch (e) {
      toastBad('麦克风操作失败：' + (e && e.message ? e.message : ''));
      return false;
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /* ---------- 悬浮麦条 ---------- */

  let pill = null;
  function ensurePill() {
    if (pill) return pill;
    pill = document.createElement('div');
    pill.className = 'lk-pill';
    pill.onclick = () => toggleMic();
    document.body.appendChild(pill);
    return pill;
  }

  function renderPill(s) {
    if (!s.active && !s.connecting) {
      if (pill) {
        pill.remove();
        pill = null;
      }
      return;
    }
    const el = ensurePill();
    if (s.connecting) {
      el.textContent = '🎙️ 连接语音…';
      el.className = 'lk-pill busy';
    } else if (s.muted) {
      el.textContent = '🔇 已静音';
      el.className = 'lk-pill muted';
    } else {
      el.textContent = '🎙️ 连麦中 · 点按静音';
      el.className = 'lk-pill live';
    }
  }

  onChange(renderPill);

  window.PQVoice = { connect, disconnect, toggleMic, status, onChange };
})();
