'use strict';
/* 重建会议后诊断双向音频 */
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
          if (r.exceptionDetails) {
            const d = r.exceptionDetails.exception;
            return res('ERR ' + ((d && d.description) || r.exceptionDetails.text).slice(0, 240));
          }
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
  throw new Error('net window missing ' + port);
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

  console.log('=== 房主 A ===');
  console.log('transceivers:', await A.ev(`JSON.stringify([...window.pqNet._internal.state.peers.values()][0].pc.getTransceivers().map(t => ({ mid: t.mid, kind: t.receiver.track && t.receiver.track.kind, dir: t.direction, current: t.currentDirection, senderTrack: !!(t.sender && t.sender.track) })))`));

  console.log('=== 成员 B ===');
  console.log('transceivers:', await B.ev(`JSON.stringify([...window.pqNet._internal.state.peers.values()][0].pc.getTransceivers().map(t => ({ mid: t.mid, kind: t.receiver.track && t.receiver.track.kind, dir: t.direction, current: t.currentDirection, senderTrack: !!(t.sender && t.sender.track) })))`));
  console.log('answer m/audio 方向:', await B.ev(`[...window.pqNet._internal.state.peers.values()][0].pc.localDescription.sdp.split('\\n').filter(l => l.startsWith('m=audio') || l.startsWith('a=sendrecv') || l.startsWith('a=sendonly') || l.startsWith('a=recvonly') || l.startsWith('a=inactive')).join(' | ')`));
  console.log('offer m/audio 方向:', await B.ev(`[...window.pqNet._internal.state.peers.values()][0].pc.remoteDescription.sdp.split('\\n').filter(l => l.startsWith('m=audio') || l.startsWith('a=sendrecv') || l.startsWith('a=sendonly') || l.startsWith('a=recvonly') || l.startsWith('a=inactive')).join(' | ')`));
  console.log('offer 里 audio m-line 个数:', await B.ev(`[...window.pqNet._internal.state.peers.values()][0].pc.remoteDescription.sdp.split('\\n').filter(l => l.startsWith('m=audio')).length`));
  console.log('answer 里 audio m-line 个数:', await B.ev(`[...window.pqNet._internal.state.peers.values()][0].pc.localDescription.sdp.split('\\n').filter(l => l.startsWith('m=audio')).length`));

  // 各端 RTP 统计
  const aIn = await A.ev(`(async()=>{const p=[...window.pqNet._internal.state.peers.values()][0];const st=await p.pc.getStats();let b=0;st.forEach(s=>{if(s.type==='inbound-rtp'&&s.kind==='audio')b=s.bytesReceived||0});return b})()`);
  const bIn = await B.ev(`(async()=>{const p=[...window.pqNet._internal.state.peers.values()][0];const st=await p.pc.getStats();let b=0;st.forEach(s=>{if(s.type==='inbound-rtp'&&s.kind==='audio')b=s.bytesReceived||0});return b})()`);
  console.log('A 收到音频字节:', aIn, '| B 收到音频字节:', bIn);

  A.close();
  B.close();
})().catch((e) => console.error('ERR', e.message));
