/* 实机验证 + 截图：首次打开的新手引导（箭头 + 文字 + 高亮）
 * 运行：env -u ELECTRON_RUN_AS_NODE npx electron dev-tests/shot-onboarding.js
 *
 * 说明：web/index.html 是无 preload 的独立窗口，boot() 会因缺少 api 中断；
 * 这里只验证引导 UI 本身——注入最小 state 后直接驱动 Guide.start()。
 * 引导状态机逻辑由 dev-tests/test-onboarding.js 覆盖。
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'shot-onboarding.png');
const INDEX = path.join(root, 'web', 'index.html');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 820, show: false, webPreferences: { partition: 'pgguide' + Date.now() } });
  await win.loadFile(INDEX);
  await new Promise((r) => setTimeout(r, 2200));

  // 注入最小 state 并启动引导（start 内部 setTimeout 120ms 后才 showStep）
  await win.webContents.executeJavaScript(`(function(){
    try {
      state = { settings: { theme: 'dark', guideDone: false }, profile: {}, plans: [], todayPlans: [] };
      if (typeof api === 'undefined') { window.api = { updateSettings: async () => ({ ok:true }) }; }
      Guide.start();
    } catch (e) {}
    return 'started';
  })()`);
  await new Promise((r) => setTimeout(r, 500)); // 等 showStep + requestAnimationFrame 完成

  const probe = await win.webContents.executeJavaScript(`(function(){
    var g = document.getElementById('pq-guide');
    return {
      module: typeof window.PQOnboarding === 'object',
      guideExists: !!g,
      visible: !!(g && g.style.display !== 'none'),
      stepText: g ? g.querySelector('.pq-guide-step').textContent : '',
      title: g ? g.querySelector('.pq-guide-title').textContent : '',
      bodyText: g ? g.querySelector('.pq-guide-text').textContent : '',
      hasNext: !!(g && g.querySelector('.pq-guide-next')),
      hasSkip: !!(g && g.querySelector('.pq-guide-skip')),
      hasArrow: !!(g && g.querySelector('.pq-guide-arrow')),
      cardLeft: g ? g.querySelector('.pq-guide-card').style.left : '',
    };
  })()`);
  if (probe.error) { console.log('PROBE-ERR', probe.error); }
  console.log('PROBE', JSON.stringify(probe));
  await new Promise((r) => setTimeout(r, 400));

  // 走一步验证导航与气泡移动（place() 是异步的，点击后要等一帧再读）
  await win.webContents.executeJavaScript(`(function(){
    var g = document.getElementById('pq-guide');
    if (g) g.querySelector('.pq-guide-next').click();
    return 'clicked';
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const step2 = await win.webContents.executeJavaScript(`(function(){
    var g = document.getElementById('pq-guide');
    return { step: g.querySelector('.pq-guide-step').textContent, title: g.querySelector('.pq-guide-title').textContent };
  })()`);
  console.log('STEP2', JSON.stringify(step2));

  let fail = 0;
  const ok = (n, c) => { console.log((c ? '  ✓ ' : '  ✗ ') + n); if (!c) fail++; };
  ok('引导模块已加载', probe.module);
  ok('引导层已注入 DOM', probe.guideExists);
  ok('启动后可见', probe.visible);
  ok('第一步是欢迎页', !!probe.title && probe.title.indexOf('欢迎') >= 0);
  ok('有步骤指示', /第 1.*步/.test(probe.stepText || ''));
  ok('有下一步按钮', probe.hasNext);
  ok('有跳过按钮', probe.hasSkip);
  ok('有箭头元素', probe.hasArrow);
  ok('气泡有定位坐标', !!probe.cardLeft);
  ok('点下一步进入第 2 步', /第 2.*步/.test(step2.step || ''));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('SHOT', out, fail ? ('FAIL ' + fail) : 'ALL PASS');
  win.destroy();
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FAIL', e && e.stack); app.exit(1); });
