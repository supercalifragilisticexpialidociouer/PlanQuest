/* 网页版守护适配层：纯浏览器环境没有原生能力，全部降级为「不支持」，
   保证 pq-core 调用时不抛异常（安卓版用的是 native-guard.js，两者不要混用）。 */
'use strict';

(function () {
  const NO = () => ({ ok: false, message: '网页版不支持系统级守护' });

  window.NativeGuard = {
    capabilities: () => ({ available: false, web: true }),

    setEnabled: NO,
    setLists: NO,
    grantTicket: NO,
    listWindowApps: async () => [],
    notify: NO,
    setEyeCare: NO,
    skipEyeCare: NO,
    eyeCareDone: NO,
    eyeCareInfo: async () => ({ enabled: false, phase: 'idle', endsAt: 0 }),
    requestUsageAccess: NO,
    requestOverlay: NO,
    showBlock: NO,
    goHome: NO,

    onUnlisted: () => () => {},
    onEyeCare: () => () => {},
    _onViolation: () => () => {},
  };
})();
