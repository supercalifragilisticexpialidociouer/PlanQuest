'use strict';
/* 重开独立联机窗口并截图 */
const fs = require('fs');

async function conn(port, re) {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  const page = list.find((t) => t.type === 'page' && re.test(t.url));
  if (!page) throw new Error('no page ' + port);
  const ws = await new Promise((r, j) => {
    const w = new WebSocket(page.webSocketDebuggerUrl);
    w.onopen = () => r(w);
    w.onerror = () => j(new Error('ws'));
  });
  let seq = 0;
  const send = (method, params) =>
    new Promise((res) => {
      const id = ++seq;
      const on = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === id) {
          ws.removeEventListener('message', on);
          res(m.result);
        }
      };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = (expr) => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => (r && r.result ? r.result.value : undefined));
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r && r.data) {
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return true;
    }
    return false;
  };
  return { ev, shot, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const out = 'C:/Users/18824/WorkBuddy/2026-10-27-21-28-50/planquest/shots';
  fs.mkdirSync(out, { recursive: true });

  const main = await conn(9223, /index\.html/);
  await main.ev('window.api.netOpenWindow("study")');
  main.close();
  await sleep(2200);

  const A = await conn(9223, /net\.html/);
  await A.ev('window.pqNet.create("study", 30)');
  await sleep(900);
  await A.shot(out + '/6-ask-enter.png');
  console.log('6-ask-enter.png');

  await A.ev('document.querySelector(".modal-mask [data-r=\\"1\\"]").click()');
  await sleep(1800);
  await A.shot(out + '/7-solo-room.png');
  console.log('7-solo-room.png');

  A.close();
})().catch((e) => console.error('ERR', e.message));
