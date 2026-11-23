'use strict';
/* 截图：大厅 / 配对 / 会议三个界面，用于人工检查可读性 */
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
  const out = process.argv[2] || 'C:/Users/18824/WorkBuddy/2026-10-27-21-28-50/planquest/shots';
  fs.mkdirSync(out, { recursive: true });

  const A = await conn(9223, /net\.html/);
  const B = await conn(9224, /net\.html/);
  await sleep(500);

  await A.shot(out + '/1-lobby.png');
  console.log('1-lobby.png');

  await A.ev('window.pqNet.create("study", 30)');
  await sleep(600);
  await A.ev('window.pqNet._internal.hostInvite()');
  await sleep(1200);
  await A.shot(out + '/2-pair.png');
  console.log('2-pair.png');

  const invite = await A.ev('(document.getElementById("net-code-text")||{}).value');
  await B.ev(`window.pqNet._internal.clientAcceptInvite(${JSON.stringify(invite)})`);
  await sleep(1500);
  const reply = await B.ev('(document.getElementById("net-code-text")||{}).value');
  await B.shot(out + '/3-client-reply.png');
  console.log('3-client-reply.png');

  await A.ev(`window.pqNet._internal.hostApplyReply(${JSON.stringify(reply)})`);
  await sleep(4000);
  await A.shot(out + '/4-connected.png');
  console.log('4-connected.png');

  await A.ev('window.pqNet._internal.enterRoom()');
  await B.ev('window.pqNet._internal.enterRoom()');
  await sleep(1200);
  await A.shot(out + '/5-meeting.png');
  console.log('5-meeting.png');

  A.close();
  B.close();
})().catch((e) => console.error('ERR', e.message));
