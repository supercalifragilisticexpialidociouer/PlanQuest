'use strict';

/* 异地联机独立窗口的引导脚本
 * net-room.js 里用的是 window.toast 和 #net-body，这里补齐页面级依赖后挂载。
 */

function pageToast(msg, sub = '', warn = false) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast' + (warn ? ' warn' : '');
  el.innerHTML = `
    <span class="ti">${warn ? '!' : '✓'}</span>
    <div class="tc">
      <div class="tt">${String(msg == null ? '' : msg).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>
      ${sub ? `<div class="sub">${String(sub).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>` : ''}
    </div>
    <span class="tbar"></span>`;
  root.appendChild(el);
  while (root.children.length > 3) root.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 2600);
}
window.toast = pageToast;

async function boot() {
  // 主题变量挂在 #app[data-theme] 上，独立页面没有 #app，需要自己打标记
  try {
    const s = await window.api.getState();
    const th = s && s.settings && s.settings.theme === 'light' ? 'light' : 'dark';
    document.body.dataset.theme = th;
  } catch (_) {
    document.body.dataset.theme = 'dark';
  }

  const q = new URLSearchParams(location.search);
  const type = q.get('type') === 'fun' ? 'fun' : 'study';
  if (window.pqNet && typeof window.pqNet.mount === 'function') {
    window.pqNet.mount(type);
  }

  const full = document.getElementById('page-full');
  if (full) {
    full.onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch (_) {}
    };
  }
}

window.addEventListener('DOMContentLoaded', boot);

/* 关窗前收尾：停止麦克风/摄像头/屏幕共享，给对端发 bye */
window.addEventListener('beforeunload', () => {
  try {
    window.pqNet && window.pqNet.leave();
  } catch (_) {}
});
