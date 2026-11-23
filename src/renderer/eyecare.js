'use strict';
/* 护眼模式全屏页：phase = exercise（眼保健操视频约 4 分钟）| rest（息屏，时长随护眼节奏 10/15/20 分钟）
   跳过任一阶段都必须验证守护密码（eyecare:skip 在主进程校验）；
   视频自然播完由 eyecare:done 通知主进程进入息屏。 */

let phase = null;
let endsAt = 0;
let total = 10 * 60000; // 息屏总时长（由主进程下发）
let useVideoClock = false;

function el(id) {
  return document.getElementById(id);
}

function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

const video = el('video');
video.addEventListener('loadeddata', () => {
  el('vload').style.display = 'none';
});
video.addEventListener('error', () => {
  el('vload').textContent = '视频加载失败，可点下方按钮跳过';
});
// 视频播完 → 自然进入息屏（不需要密码）
video.addEventListener('ended', () => {
  if (phase === 'exercise') {
    try {
      api.eyeCareDone();
    } catch (_) {}
  }
});

function show(p) {
  phase = p.phase;
  document.body.classList.toggle('rest', phase === 'rest');
  const isEx = phase === 'exercise';
  el('cap').textContent = isEx ? 'EYE CARE · 护眼时间' : 'REST · 息屏休息';
  el('title').textContent = isEx ? '👁 眼保健操时间' : '🌙 息屏休息中';
  el('sub').textContent = isEx ? '跟着视频做一做 · 做完自动进入息屏' : '闭眼或看远处，让眼睛休息一会儿';
  el('vbox').style.display = isEx ? '' : 'none';
  el('rest-hint').style.display = isEx ? 'none' : '';
  total = Number(p.total) || (isEx ? 4 * 60000 : 10 * 60000);
  endsAt = p.endsAt || Date.now() + total;
  useVideoClock = isEx;
  if (isEx) {
    el('vload').style.display = '';
    video.currentTime = 0;
    const play = video.play();
    if (play && play.catch) play.catch(() => {});
  } else {
    try {
      video.pause();
    } catch (_) {}
  }
  tick();
}
setInterval(tick, 500);

function tick() {
  if (!phase) return;
  if (useVideoClock && video.duration) {
    // 引导阶段进度条跟视频走
    el('clock').textContent = fmt((video.duration - video.currentTime) * 1000);
    el('bar').style.width = Math.min(100, (video.currentTime / video.duration) * 100) + '%';
  } else {
    const left = endsAt - Date.now();
    el('clock').textContent = fmt(left);
    el('bar').style.width = Math.max(0, Math.min(100, 100 - (left / total) * 100)) + '%';
  }
}

/* 跳过：必须验证守护密码 */
el('skip').onclick = () => {
  el('pw-err').textContent = '';
  el('pw').value = '';
  el('pw-mask').classList.add('show');
  setTimeout(() => el('pw').focus(), 60);
};
el('pw-no').onclick = () => el('pw-mask').classList.remove('show');
async function trySkip() {
  const pw = el('pw').value;
  const r = await api.eyeCareSkip({ password: pw });
  if (r && r.ok) {
    el('pw-mask').classList.remove('show');
    return; // 主进程会推下一阶段或直接关窗
  }
  el('pw-err').textContent = (r && r.message) || '密码不对';
  el('pw-box').classList.remove('shake');
  void el('pw-box').offsetWidth;
  el('pw-box').classList.add('shake');
}
el('pw-ok').onclick = trySkip;
el('pw').addEventListener('keydown', (e) => e.key === 'Enter' && trySkip());

api.onEyeCare((p) => show(p));

/* 若打开时已在阶段中（窗口被复用），主动问一次主进程 */
(async () => {
  try {
    const info = await api.eyeCareInfo();
    if (info && info.phase && info.endsAt > Date.now()) show(info);
  } catch (_) {}
})();
