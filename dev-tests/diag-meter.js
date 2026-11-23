'use strict';
/* 重建会议后诊断音量探针 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function conn(port, re) {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  const page = list.find((t) => t.type === 'page' && re.test(t.url));
  if (!page) return null;
  const ws = await new Promise((r, j) => {
    const w = new WebSocket(page.webSocketDebuggerUrl);
    w.onopen = () => r(w);
    w.onerror = () => j(new Error('ws'));
  });
  let seq = 0;
  const ev = (expr) =>
    new Promise((res) => {
      const id = ++seq;
      const t = setTimeout(() => res('TIMEOUT'), 15000);
      const on = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === id) {
          clearTimeout(t);
          ws.removeEventListener('message', on);
          const r = m.result;
          if (r.exceptionDetails) return res('ERR ' + (r.exceptionDetails.exception?.description || '').slice(0, 200));
          res(r.result.value);
        }
      };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
  return { ev, close: () => ws.close() };
}

async function openNet(port) {
  const main = await conn(port, /index\.html/);
  await main.ev('window.api.netOpenWindow("study")');
  main.close();
  for (let i = 0; i < 25; i++) {
    await sleep(350);
    const p = await conn(port, /net\.html/);
    if (p) return p;
  }
  throw new Error('net window missing');
}

(async () => {
  const A = await openNet(9223);
  const B = await openNet(9224);
  for (let i = 0; i < 20; i++) {
    if (await A.ev('!!document.querySelector(".lobby-cards")')) break;
    await sleep(300);
  }
  await A.ev('window.pqNet.create("study", 30)');
  await sleep(500);
  await A.ev('window.pqNet._internal.hostInvite()');
  await sleep(1300);
  const invite = await A.ev('(document.getElementById("net-code-text")||{}).value');
  await B.ev(`window.pqNet._internal.clientAcceptInvite(${JSON.stringify(invite)})`);
  await sleep(1500);
  const reply = await B.ev('(document.getElementById("net-code-text")||{}).value');
  await A.ev(`window.pqNet._internal.hostApplyReply(${JSON.stringify(reply)})`);
  await sleep(4000);
  await A.ev('window.pqNet._internal.enterRoom()');
  await B.ev('window.pqNet._internal.enterRoom()');
  await sleep(3000);

  for (const [name, X] of [['房主', A], ['成员', B]]) {
    console.log(`=== ${name} ===`);
    console.log('audioCtx:', await X.ev('(window.pqNet._internal.state.audioCtx||{}).state || "null"'));
    console.log('micTimer:', await X.ev('!!window.pqNet._internal.state.micTimer'));
    console.log('micTrack:', await X.ev('(()=>{const s=window.pqNet._internal.state.micStream;if(!s)return "null";const t=s.getAudioTracks()[0];return "muted="+t.muted+" enabled="+t.enabled+" ready="+t.readyState})()'));
    console.log('micLevel:', await X.ev('window.pqNet._internal.state.micLevel'));
    console.log('speaking:', await X.ev('window.pqNet._internal.state.micLevel > 0.02'));
  }

  A.close();
  B.close();
})().catch((e) => console.error('ERR', e.message));
