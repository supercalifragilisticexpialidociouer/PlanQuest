'use strict';
/* 异地联机联测（独立窗口版）：打开独立页面 → 手动配对 → 进入房间 → 会议界面与消息互通 */

const A_PORT = 9223;
const B_PORT = 9224;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json`);
  return r.json();
}

async function connectPage(port, re) {
  const list = await targets(port);
  const page = list.find((t) => t.type === 'page' && re.test(t.url));
  if (!page) return null;
  const ws = await new Promise((res, rej) => {
    const w = new WebSocket(page.webSocketDebuggerUrl);
    w.onopen = () => res(w);
    w.onerror = () => rej(new Error('ws 失败 ' + port));
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

async function openNetWindow(port, type) {
  const main = await connectPage(port, /index\.html/);
  if (!main) throw new Error('主窗口未就绪 ' + port);
  await main.ev(`window.api.netOpenWindow(${JSON.stringify(type)})`);
  main.close();
  for (let i = 0; i < 25; i++) {
    await sleep(350);
    const page = await connectPage(port, /net\.html/);
    if (page) return page;
  }
  throw new Error('独立窗口没有出现 ' + port);
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
  const A = await openNetWindow(A_PORT, 'study');
  const B = await openNetWindow(B_PORT, 'study');
  console.log('两个独立窗口已打开\n');

  // 等 boot()（读取主题 + mount）完成
  for (let i = 0; i < 25; i++) {
    if (await A.ev('!!document.querySelector(".lobby-cards")')) break;
    await sleep(300);
  }

  check('独立页面加载（非主界面背景）', (await A.ev('document.body.classList.contains("net-page")')) === true);
  check('大厅可见', (await A.ev('!!document.querySelector(".lobby-cards")')) === true);
  check('主题变量已注入（文字不会变黑）', (await A.ev('getComputedStyle(document.body).getPropertyValue("--text").trim()')).length > 0, await A.ev('document.body.dataset.theme'));

  await A.ev('window.pqNet.create("study", 30)');
  await sleep(600);
  const codeA = await A.ev('window.pqNet._internal.state.code');
  check('房主创建房间', typeof codeA === 'string' && codeA.length === 6, '房间号 ' + codeA);
  check('创建后进入配对界面', (await A.ev('!!document.querySelector(".pair-head")')) === true);
  check('创建后自动弹出「是否进入房间」', (await A.ev('!!document.querySelector(".modal-mask [data-r=\\"1\\"]")')) === true);
  await A.ev('document.querySelector(".modal-mask [data-r=\\"0\\"]").click()');
  await sleep(300);
  check('选「稍后」关掉确认框', (await A.ev('!!document.querySelector(".modal-mask")')) === false);

  await A.ev('window.pqNet._internal.hostInvite()');
  await sleep(1400);
  const invite = await A.ev('(document.getElementById("net-code-text")||{}).value');
  check('生成邀请码', typeof invite === 'string' && invite.startsWith('z'), (invite || '').length + ' 字符');
  check('邀请码适合微信发送', (invite || '').length < 4000, (invite || '').length + ' < 4000');

  await B.ev(`window.pqNet._internal.clientAcceptInvite(${JSON.stringify(invite)})`);
  await sleep(1600);
  const reply = await B.ev('(document.getElementById("net-code-text")||{}).value');
  check('成员生成回执码', typeof reply === 'string' && reply.startsWith('z'), (reply || '').length + ' 字符');

  await A.ev(`window.pqNet._internal.hostApplyReply(${JSON.stringify(reply)})`);
  await sleep(4200);
  const aPeers = await A.ev('window.pqNet._internal.peers().length');
  const bPeers = await B.ev('window.pqNet._internal.peers().length');
  check('房主侧通道打开', aPeers === 1, 'peers=' + aPeers);
  check('成员侧通道打开', bPeers === 1, 'peers=' + bPeers);

  const aAudio = await A.ev('[...window.pqNet._internal.state.peers.values()].some(p => p.pc.getTransceivers().some(t => t.receiver.track && t.receiver.track.kind === "audio"))');
  check('语音通道已预留', aAudio === true);

  check('配对阶段不显示会议主体', (await A.ev('!!document.getElementById("meet-stage")')) === false);

  await A.ev('window.pqNet._internal.enterRoom()');
  await B.ev('window.pqNet._internal.enterRoom()');
  await sleep(800);
  check('进入后显示会议界面', (await A.ev('!!document.getElementById("meet-stage")')) === true);
  const tiles = await A.ev('document.querySelectorAll(".mtile").length');
  check('会议格子渲染', tiles === 2, 'tiles=' + tiles);
  const avatars = await A.ev('document.querySelectorAll(".mtile-ph .mtile-av").length');
  check('无画面显示头像', avatars >= 2, avatars + ' 个头像');
  check('有全屏按钮', (await A.ev('!!document.getElementById("page-full")')) === true);
  check('有关麦克风按钮', (await A.ev('!!document.querySelector(\'[data-net="mic"]\')')) === true);

  await B.ev('window.pqNet.sendChat("你好，我是成员")');
  await sleep(900);
  const aChat = await A.ev('window.pqNet._internal.chatOf().map(m => m.text).join("|")');
  check('成员→房主 聊天送达', String(aChat).includes('你好，我是成员'), String(aChat).slice(0, 26));
  await A.ev('window.pqNet.sendChat("房主在线")');
  await sleep(900);
  const bChat = await B.ev('window.pqNet._internal.chatOf().map(m => m.text).join("|")');
  check('房主→成员 聊天送达', String(bChat).includes('房主在线'), String(bChat).slice(0, 26));

  await A.ev('window.pqNet.leave()');
  await sleep(1600);
  const bAfter = await B.ev('window.pqNet._internal.peers().length');
  check('房主退出后成员侧清空并退回', bAfter === 0, 'peers=' + bAfter);

  // 【新增】房主可以不等成员，自己先进房间等人
  await A.ev('window.pqNet.create("study", 30)');
  await sleep(600);
  await A.ev('document.querySelector(".modal-mask [data-r=\\"1\\"]").click()');
  await sleep(1200);
  check('房主能独自先进入房间', (await A.ev('!!document.getElementById("meet-stage")')) === true);
  const soloTiles = await A.ev('document.querySelectorAll(".mtile").length');
  check('独自进房显示「等待成员」格子', soloTiles === 2, 'tiles=' + soloTiles);
  await A.ev('window.pqNet.leave()');

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  A.close();
  B.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('联测异常:', e.message);
  process.exit(1);
});
