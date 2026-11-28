/* onboarding.js —— 新手引导步骤表与状态判定（双端 UMD 同源，无 DOM）
 *
 * 产品口径：
 *  1. 首次打开软件显示一次，用箭头 + 文字指着真实界面元素走一遍；看完 / 跳过写 guideDone=true，
 *     之后默认不再显示。
 *  2. 设置里可随时重新打开（把 guideDone 置 false 并立即重播）。
 *  3. 只讲「在哪、能干什么」，含蓄暗示阿刺脾气随外形，不摊牌任何概率 / 参数。
 *
 * 渲染层（app.js）负责按 step.target 取 DOM、画高亮 + 箭头气泡 + 上一步/下一步/跳过按钮。
 * 本模块只给纯数据，便于单测与三端同源。
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.PQOnboarding = mod;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  /* 步骤表：target 是 CSS 选择器；view 是进入该步前要切到的页（null 表示不动）；
   * place 是气泡相对高亮块的位置（top/bottom/left/right/center）。 */
  var STEPS = [
    {
      id: 'welcome',
      view: 'today',
      target: null,
      place: 'center',
      title: '欢迎来到 PlanQuest',
      text: '用几秒钟带你认个门。跟着箭头走一遍，以后就不打扰你了。'
    },
    {
      id: 'nav',
      view: null,
      target: '#nav',
      place: 'right',
      title: '左边是你的地图',
      text: '今日打卡、计划、目标、自习房、军团……都在这排按钮里。想干啥，点一下就过去。'
    },
    {
      id: 'today',
      view: 'today',
      target: '#view',
      place: 'right',
      title: '今天要做的事，都在这',
      text: '这是「今日」页。到点没做的会挂个 !，点一下就能打卡拿积分。补做完，罚金也跟着归零。'
    },
    {
      id: 'plans',
      view: 'plans',
      target: '#view',
      place: 'right',
      title: '计划自己说了算',
      text: '在「计划」页定时、定积分。契约任务一旦创建就锁死——不可改、不可停用，想清楚再存。'
    },
    {
      id: 'buddy',
      view: null,
      target: '#pqb-fab',
      place: 'right',
      title: '左下角那位是阿刺',
      text: '它陪你、怼你，偶尔替你扛一下。你选的外形决定它是谁——脾气随外形，处久了还会变，自己琢磨。'
    },
    {
      id: 'settings',
      view: 'settings',
      target: '#view',
      place: 'right',
      title: '设置里什么都找得到',
      text: '开机自启、提醒、只读模式都在这。这份引导也能在设置里重新打开。好了，去把它用起来吧。'
    }
  ];

  function shouldShow(settings) {
    var s = settings || {};
    return s.guideDone !== true;
  }

  function stepAt(i) {
    var n = STEPS.length;
    var k = ((i % n) + n) % n;
    return STEPS[k];
  }

  function nextIndex(i, total) {
    var n = typeof total === 'number' && total > 0 ? total : STEPS.length;
    if (i >= n - 1) return -1; // 走完
    return i + 1;
  }

  function prevIndex(i) {
    return i > 0 ? i - 1 : 0;
  }

  /* 生成高亮块与气泡的位置；返回像素坐标，交给渲染层直接写 style。
   * rect = { left, top, width, height }，vp = { w, h }，card = { w, h }。
   * 贴边时自动翻到对侧，保证气泡不出视口。 */
  function place(rect, vp, card, mode) {
    var pad = 14, gap = 18;
    var vw = Math.max(320, Number(vp && vp.w) || 0);
    var vh = Math.max(240, Number(vp && vp.h) || 0);
    var cw = Math.min(Number(card && card.w) || 340, vw - pad * 2);
    var ch = Number(card && card.h) || 150;
    var r = rect || { left: vw / 2, top: vh / 2, width: 0, height: 0 };
    var left, top, arrow;

    if (mode === 'center' || !rect) {
      left = (vw - cw) / 2;
      top = (vh - ch) / 2;
      return { left: left, top: top, arrow: 'none', highlight: null };
    }

    var m = mode || 'right';
    function fitsRight() { return r.left + r.width + gap + cw <= vw - pad; }
    function fitsLeft() { return r.left - gap - cw >= pad; }
    function fitsBelow() { return r.top + r.height + gap + ch <= vh - pad; }
    function fitsAbove() { return r.top - gap - ch >= pad; }

    if (m === 'left' && fitsLeft()) { left = r.left - gap - cw; top = r.top + (r.height - ch) / 2; arrow = 'right'; }
    else if (m === 'top' && fitsAbove()) { left = r.left + (r.width - cw) / 2; top = r.top - gap - ch; arrow = 'down'; }
    else if (m === 'bottom' && fitsBelow()) { left = r.left + (r.width - cw) / 2; top = r.top + r.height + gap; arrow = 'up'; }
    else if (fitsRight()) { left = r.left + r.width + gap; top = r.top + (r.height - ch) / 2; arrow = 'left'; }
    else if (fitsLeft()) { left = r.left - gap - cw; top = r.top + (r.height - ch) / 2; arrow = 'right'; }
    else if (fitsBelow()) { left = r.left + (r.width - cw) / 2; top = r.top + r.height + gap; arrow = 'up'; }
    else if (fitsAbove()) { left = r.left + (r.width - cw) / 2; top = r.top - gap - ch; arrow = 'down'; }
    else { left = (vw - cw) / 2; top = (vh - ch) / 2; arrow = 'none'; }

    left = Math.max(pad, Math.min(left, vw - cw - pad));
    top = Math.max(pad, Math.min(top, vh - ch - pad));
    return {
      left: Math.round(left), top: Math.round(top), arrow: arrow,
      highlight: {
        left: Math.round(r.left - 5), top: Math.round(r.top - 5),
        width: Math.round(r.width + 10), height: Math.round(r.height + 10)
      }
    };
  }

  return {
    STEPS: STEPS,
    count: STEPS.length,
    shouldShow: shouldShow,
    stepAt: stepAt,
    nextIndex: nextIndex,
    prevIndex: prevIndex,
    place: place
  };
});
