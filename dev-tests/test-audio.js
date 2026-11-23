'use strict';
/* 语音专项验证：用 Chromium 虚拟麦克风（正弦波）验证
 * ① 进房自动开麦 ② RTP 音频包真的到达对方（inbound bytesReceived > 0）③ 远端 audio 元素在播 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json`)).json();
}

async function connectPage(port, re) {
  const list = await targets(port);
  const page = list.find((t) => t.type === 'page' && re.test(t.url));
  if (!page) return null;
  const ws = await new Promise((res, rej) => {
    const w = new WebSocket(page.webSocketDebuggerUrl);
    w.onopen = () => res(w);
    w.onerror = () => rej(new Error('ws'));
  });
  let seq = 0;
  const ev = (expr, timeout = 25000) =>
    new Promise((resolve) => {
      const id = ++seq;
      const t = setTimeout(() => resolve('__TIMEOUT__'), timeout);
      const on = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === id) {
          clearTimeout(t);
          ws.removeEventListener('message', on);
          const r = m.result;
          if (r && r.exceptionDetails) {
            const d = r.exceptionDetails.exception;
            return resolve('__ERR__ ' + ((d && d.description) || r.exceptionDetails.text));
          }
          resolve(r?.result?.value);
        }
      };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
  return { ws, ev, close: () => ws.close() };
}

async function openNet(port) {
  const main = await connectPage(port, /index\.html/);
  if (!main) throw new Error('主窗口未就绪 ' + port);
  await main.ev('window.api.netOpenWindow("study")');
  main.close();
  for (let i = 0; i < 25; i++) {
    await sleep(350);
    const p = await connectPage(port, /net\.html/);
    if (p) return p;
  }
  throw new Error('独立窗口未出现 ' + port);
}

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : ''));
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  (' + extra + ')' : ''));
  }
}

(async () => {
  const A = await openNet(9223);
  const B = await openNet(9224);
  console.log('两个独立窗口已打开\n');

  for (let i = 0; i < 20; i++) {
    if (await A.ev('!!document.querySelector(".lobby-cards")')) break;
    await sleep(300);
  }

  await A.ev('window.pqNet.create("study", 30)');
  await sleep(600);
  await A.ev('window.pqNet._internal.hostInvite()');
  await sleep(1300);
  const invite = await A.ev('(document.getElementById("net-code-text")||{}).value');
  await B.ev(`window.pqNet._internal.clientAcceptInvite(${JSON.stringify(invite)})`);
  await sleep(1600);
  const reply = await B.ev('(document.getElementById("net-code-text")||{}).value');
  await A.ev(`window.pqNet._internal.hostApplyReply(${JSON.stringify(reply)})`);
  await sleep(4200);

  const aOpen = await A.ev('[...window.pqNet._internal.state.peers.values()].every(p => p.dc && p.dc.readyState === "open")');
  const bOpen = await B.ev('[...window.pqNet._internal.state.peers.values()].every(p => p.dc && p.dc.readyState === "open")');
  check('连接已建立', aOpen === true && bOpen === true);

  // 进入房间 → 自动开麦
  await A.ev('window.pqNet._internal.enterRoom()');
  await B.ev('window.pqNet._internal.enterRoom()');
  await sleep(2500);

  const aMic = await A.ev('window.pqNet._internal.state.micOn');
  const bMic = await B.ev('window.pqNet._internal.state.micOn');
  check('房主进房自动开麦', aMic === true, 'micOn=' + aMic);
  check('成员进房自动开麦', bMic === true, 'micOn=' + bMic);

  // 等几秒让 RTP 音频包流动
  await sleep(4000);

  // B 侧：应收到 A 的音频（inbound-rtp audio bytesReceived > 0）
  const bIn = await B.ev(`
    (async () => {
      const p = [...window.pqNet._internal.state.peers.values()][0];
      const stats = await p.pc.getStats();
      let bytes = 0, packets = 0, codec = '';
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') {
          bytes = s.bytesReceived || 0;
          packets = s.packetsReceived || 0;
        }
      });
      const aud = document.querySelector('audio');
      return { bytes, packets, audioEls: document.querySelectorAll('audio').length, paused: aud ? aud.paused : null };
    })()
  `);
  console.log('成员侧接收统计:', JSON.stringify(bIn));
  check('成员真的收到了房主的声音（RTP 字节 > 0）', bIn && bIn.bytes > 0, bIn && bIn.bytes + ' bytes / ' + bIn.packets + ' packets');
  check('成员侧音频元素在播放', bIn && bIn.audioEls >= 1 && bIn.paused === false, 'paused=' + (bIn && bIn.paused));

  // A 侧：应收到 B 的音频
  const aIn = await A.ev(`
    (async () => {
      const p = [...window.pqNet._internal.state.peers.values()][0];
      const stats = await p.pc.getStats();
      let bytes = 0;
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes = s.bytesReceived || 0;
      });
      const aud = document.querySelector('audio');
      return { bytes, audioEls: document.querySelectorAll('audio').length, paused: aud ? aud.paused : null };
    })()
  `);
  console.log('房主侧接收统计:', JSON.stringify(aIn));
  check('房主真的收到了成员的声音（RTP 字节 > 0）', aIn && aIn.bytes > 0, aIn && aIn.bytes + ' bytes');

  // 说话高亮状态（fake device 音量稳定，speaking 应为 true）
  const aSpeak = await A.ev('window.pqNet._internal.state.micLevel > 0.02');
  check('本地说话检测生效', aSpeak === true, 'micLevel=' + (await A.ev('window.pqNet._internal.state.micLevel.toFixed(3)')));

  await A.ev('window.pqNet.leave()');
  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  A.close();
  B.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('音频联测异常:', e.message);
  process.exit(1);
});
