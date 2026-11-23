/* 动态图标（手机版 / 网页版）
 * 规则与桌面版一致：有任务进行中（计划时段内）→ 图标顺滑变色；
 * 空闲 → 恢复初始配色。
 *  - 安卓：切换 activity-alias（IndIcon0..5），改的是手机桌面上的启动图标
 *  - 网页：切换 favicon，标签页图标跟着流转
 * 桌面版由 Electron 主进程处理（窗口图标 + 桌面快捷方式），不走这里。
 */
'use strict';

(function () {
  const FRAMES = 6;        // 6 帧 = 颜色环 60° 一档
  const TICK_MS = 900;     // 每帧停留
  const POLL_MS = 3000;    // 多久检查一次「有没有任务进行中」

  const cap = window.Capacitor || {};
  const isNative = typeof cap.isNativePlatform === 'function' ? cap.isNativePlatform() : false;
  const platform = typeof cap.getPlatform === 'function' ? cap.getPlatform() : (isNative ? 'android' : 'web');
  const nativeIcon = isNative && typeof cap.registerPlugin === 'function' ? cap.registerPlugin('IndIcon') : null;

  let idx = 0;
  let timer = null;
  let poll = null;
  let lastActive = null;
  let switching = false;

  function paint(i) {
    idx = ((i % FRAMES) + FRAMES) % FRAMES;
    if (nativeIcon) {
      try { nativeIcon.set({ i: idx }).catch(() => {}); } catch (_) {}
      return;
    }
    // 网页：切 favicon
    const href = idx === 0 ? 'icon.png' : `assets/ind/${String(idx).padStart(2, '0')}.png`;
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = href;
  }

  function startAnim() {
    if (timer) return;
    paint(1);
    timer = setInterval(() => paint(idx + 1), TICK_MS);
  }

  function stopAnim() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    paint(0); // 恢复初始配色
  }

  function apply(active) {
    if (active === lastActive) return;
    const firstRun = lastActive === null; // 启动时的第一次检测不弹提示
    lastActive = active;
    if (active) startAnim();
    else stopAnim();
    try {
      if (!firstRun && typeof window.toast === 'function') {
        window.toast(
          active ? '🎨 有任务进行中' : '🎨 任务已结束',
          active ? '图标开始变色，做完任务就恢复原色' : '图标已恢复初始配色'
        );
      }
    } catch (_) {}
  }

  async function check() {
    if (switching) return;
    switching = true;
    try {
      const s = window.api && window.api.getState ? await window.api.getState() : null;
      if (!s) return;
      let active = !!s.activeNow;
      // 兜底：核心没给 activeNow 时，用今日计划自行判断（进行中且未完成）
      if (typeof s.activeNow !== 'boolean' && Array.isArray(s.todayPlans)) {
        active = s.todayPlans.some((p) => p.status === 'pending' || p.status === 'awaiting');
      }
      apply(active);
    } catch (_) {
    } finally {
      switching = false;
    }
  }

  function boot() {
    if (typeof window.api === 'undefined') {
      // api 还没就绪，稍后再来
      setTimeout(boot, 800);
      return;
    }
    check();
    poll = setInterval(check, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) check();
    });
  }

  window.PQIndIcon = { check, start: startAnim, stop: stopAnim, paint };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
