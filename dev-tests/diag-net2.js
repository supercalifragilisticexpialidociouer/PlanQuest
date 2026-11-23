'use strict';
/* 诊断：在 B 实例上执行 clientAcceptInvite，打印真实异常 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function conn(port) {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  const page = list.find((t) => t.type === 'page');
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
            return res('ERR: ' + ((d && d.description) || r.exceptionDetails.text));
          }
          res(r.result.value);
        }
      };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
  return { ev, close: () => ws.close() };
}

(async () => {
  const A = await conn(9223);
  const B = await conn(9224);

  // 重置 A 到房主态
  await A.ev('window.pqNet.openPanel()');
  await A.ev('window.pqNet.create()');
  await sleep(400);
  await A.ev('window.pqNet._internal.hostInvite()');
  await sleep(1200);
  const invite = await A.ev('(document.getElementById("net-code-text")||{}).value');
  console.log('邀请码长度:', String(invite).length);

  // 在 B 上验证解包
  const un = await B.ev(`window.api.netUnpack(${JSON.stringify(invite)}).then(r => r.ok + "|" + (r.ok ? r.obj.t + "|" + (r.obj.sdp && r.obj.sdp.type) : r.msg))`);
  console.log('B 解包邀请码:', un);

  // 手动跑 clientAcceptInvite 并抓异常
  const out = await B.ev(`
    (async () => {
      try {
        const un = await window.api.netUnpack(${JSON.stringify(invite)});
        if (!un.ok) return 'unpack fail: ' + un.msg;
        const sdp = un.obj.sdp;
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.ondatachannel = (e) => { window.__gotDc = e.channel; };
        await pc.setRemoteDescription(sdp);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        return 'ok state=' + pc.signalingState + ' ice=' + pc.iceGatheringState;
      } catch (e) { return 'ERR ' + e.name + ': ' + e.message; }
    })()
  `);
  console.log('B 手动走 WebRTC 应答:', out);
  console.log('B 直调函数:', await B.ev(`window.pqNet._internal.clientAcceptInvite(${JSON.stringify(invite)}).then(() => 'returned').catch(e => 'THROW ' + e.name + ': ' + e.message)`));
  await sleep(1500);
  console.log('B mode:', await B.ev('window.pqNet._internal.state.mode'));
  console.log('B codeBox:', await B.ev('!!document.getElementById("net-code-box")'));
  console.log('B reply len:', await B.ev('((document.getElementById("net-code-text")||{}).value||"").length'));
  console.log('B body:', await B.ev('(document.getElementById("net-body")||{}).innerHTML ? document.getElementById("net-body").innerHTML.slice(0,120) : "null"'));

  A.close();
  B.close();
})().catch((e) => console.error('DIAG ERR', e.message));
