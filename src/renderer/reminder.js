'use strict';

let currentPlanId = null;
let isTest = false;

function el(id) {
  return document.getElementById(id);
}

function hexBg(hex, a = 0.22) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `linear-gradient(135deg, rgba(${r},${g},${b},${a}), rgba(${r},${g},${b},${a / 2}))`;
}

function render(payload) {
  const p = payload.plan || {};
  currentPlanId = p.id;
  isTest = !!payload.test;

  el('r-ico').textContent = p.icon || '🎯';
  el('r-ico').style.background = hexBg(colorHex(p.color));
  el('r-cap').textContent = isTest ? '测试提醒（不会记入打卡）' : '到点提醒 · 该打卡了';
  el('r-title').textContent = p.title || '计划提醒';
  el('r-desc').textContent = p.desc || '';

  const chips = [`⏰ ${p.time || '--:--'}`];
  if (!isTest) chips.push(`完成 +${p.points || 20} 积分`);
  if (isTest) chips.push('试一试弹窗效果');
  el('r-meta').innerHTML = chips
    .map((c, i) => `<span class="chip ${i === 1 ? 'gain' : i === 0 ? 'accent' : ''}">${c}</span>`)
    .join('');

  el('r-later').textContent = '稍后';
}

function colorHex(name) {
  return (
    {
      mint: '#17cda8',
      indigo: '#7c6cff',
      coral: '#ff6b81',
      amber: '#ffb454',
      violet: '#a855f7',
      sky: '#38bdf8',
    }[name] || '#7c6cff'
  );
}

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [660, 880, 1100];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, ctx.currentTime + i * 0.16);
      g.gain.linearRampToValueAtTime(0.14, ctx.currentTime + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.16 + 0.4);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.16);
      o.stop(ctx.currentTime + i * 0.16 + 0.45);
    });
  } catch (_) {}
}

async function act(action) {
  if (!currentPlanId) return;
  const res = await api.reminderAction({ planId: currentPlanId, action, test: isTest });
  const result = res && res.result;
  // 需密码确认的计划：主进程已记为「待验证」，窗口正常关闭，稍后在主界面验证
  if (action === 'done' && result && result.pending) {
    window.close();
    return;
  }
  window.close();
}

el('r-done').onclick = () => act('done');
el('r-later').onclick = () => act('snooze');
el('r-skip').onclick = () => act('skip');

api.onReminder((payload) => {
  render(payload);
  chime();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') act('done');
  if (e.key === 'Escape') act('skip');
});
