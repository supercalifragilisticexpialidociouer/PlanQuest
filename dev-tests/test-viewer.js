/* 验证共享画面全屏查看器：铺满视口 + 双击切原始像素 */
const PORT = 9226;
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws connect failed'));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  };
  return { ev, shot, close: () => ws.close() };
}

(async () => {
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error('未找到主窗口页面: ' + JSON.stringify(list.map((t) => t.url)));
  const A = await connect(page.webSocketDebuggerUrl);

  let pass = 0;
  let fail = 0;
  const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    ok ? pass++ : fail++;
  };

  // 注入一张 1920×1080 的高清测试帧（模拟别人共享的屏幕）
  await A.ev(`(() => {
    const c = document.createElement('canvas');
    c.width = 1920; c.height = 1080;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1920, 1080);
    g.addColorStop(0, '#0b2545'); g.addColorStop(1, '#134074');
    x.fillStyle = g; x.fillRect(0, 0, 1920, 1080);
    x.strokeStyle = '#8da9c4'; x.lineWidth = 4;
    for (let i = 0; i < 1920; i += 80) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 1080); x.stroke(); }
    x.fillStyle = '#fff'; x.font = 'bold 140px sans-serif';
    x.fillText('SHARED SCREEN 1920x1080', 160, 500);
    x.font = '64px sans-serif'; x.fillStyle = '#9fd3ff';
    x.fillText('细节测试：ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789', 160, 640);
    scrFrames.set('self', { url: c.toDataURL('image/jpeg', 0.85), at: Date.now() });
    openFrameViewer('scr', 'self', '共享屏幕（我）');
    return true;
  })()`);
  await sleep(700);

  const geo = await A.ev(`(() => {
    const m = document.querySelector('#pic-viewer'); const i = document.querySelector('#pv-img');
    if (!m || !i) return null;
    const r = i.getBoundingClientRect();
    return { vw: innerWidth, vh: innerHeight, w: Math.round(r.width), h: Math.round(r.height), of: getComputedStyle(i).objectFit, nat: i.naturalWidth + 'x' + i.naturalHeight, full: outerWidth >= screen.width - 8 && outerHeight >= screen.height - 8 };
  })()`);
  check('查看器已打开', !!geo, JSON.stringify(geo));
  if (geo) {
    check('默认 cover 铺满整个视口', geo.of === 'cover' && geo.w >= geo.vw - 2 && geo.h >= geo.vh - 2, `${geo.w}x${geo.h} / 视口 ${geo.vw}x${geo.vh} · ${geo.of}`);
    check('窗口已进入全屏', geo.full === true, 'outer ' + geo.full);
  }
  await A.shot(path.join(__dirname, '..', 'shots', '11-viewer-fullscreen.png'));

  // 双击 1 → contain 完整显示
  await A.ev(`(() => { document.querySelector('#pic-viewer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
  await sleep(400);
  const two = await A.ev(`(() => { const i = document.querySelector('#pv-img'); return { of: getComputedStyle(i).objectFit, w: Math.round(i.getBoundingClientRect().width), h: Math.round(i.getBoundingClientRect().height) }; })()`);
  check('双击切到完整显示 contain', two && two.of === 'contain', JSON.stringify(two));

  // 双击 2 → 原始像素 1:1
  await A.ev(`(() => { document.querySelector('#pic-viewer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
  await sleep(400);
  const one = await A.ev(`(() => { const i = document.querySelector('#pv-img'); const r = i.getBoundingClientRect(); return { of: getComputedStyle(i).objectFit, w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  check('再双击切到原始像素 1920x1080', one && one.of === 'none' && one.w === 1920 && one.h === 1080, JSON.stringify(one));
  await A.shot(path.join(__dirname, '..', 'shots', '12-viewer-1to1.png'));

  // 单击（延迟 220ms）退出
  await A.ev(`(() => { const m = document.querySelector('#pic-viewer'); m.click(); return true; })()`);
  await sleep(600);
  const gone = await A.ev(`!document.querySelector('#pic-viewer')`);
  check('单击退出浮层', gone === true);

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  A.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
