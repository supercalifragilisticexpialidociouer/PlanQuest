'use strict';
/* 局域网房间独立窗口 + 主界面全屏按钮验证 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function conn(port, pred) {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  const page = list.find((t) => t.type === 'page' && pred(t));
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

let pass = 0;
let fail = 0;
const check = (n, c, x) => {
  if (c) {
    pass++;
    console.log('  PASS  ' + n + (x ? '  (' + x + ')' : ''));
  } else {
    fail++;
    console.log('  FAIL  ' + n + (x ? '  (' + x + ')' : ''));
  }
};

(async () => {
  const main = await conn(9223, (t) => /index\.html/.test(t.url) && !t.url.includes('standalone'));
  if (!main) throw new Error('主窗口未就绪');
  for (let i = 0; i < 20; i++) {
    if ((await main.ev('typeof api')) === 'object') break;
    await sleep(400);
  }

  check('主界面有全屏按钮', (await main.ev('!!document.getElementById("btn-full")')) === true);
  check('全屏按钮已绑定', (await main.ev('typeof document.getElementById("btn-full").onclick')) === 'function');

  // 打开局域网房间独立窗口
  await main.ev('window.api.roomOpenWindow("study")');
  let room = null;
  for (let i = 0; i < 25; i++) {
    await sleep(400);
    room = await conn(9223, (t) => /standalone=1/.test(t.url));
    if (room) break;
  }
  check('独立窗口已打开', !!room);

  if (room) {
    for (let i = 0; i < 20; i++) {
      if ((await room.ev('typeof api')) === 'object') break;
      await sleep(400);
    }
    check('独立窗口是 standalone 模式', (await room.ev('document.body.classList.contains("standalone")')) === true);
    check('侧栏已隐藏', (await room.ev('getComputedStyle(document.querySelector(".sidebar")).display')) === 'none');
    check('当前在自习视图', (await room.ev('!!document.querySelector(".room-entry, .room-live")')) === true);
    check('独立窗口也有全屏按钮', (await room.ev('!!document.getElementById("btn-full")')) === true);
    const title = await room.ev('document.title');
    check('窗口标题正确', /PlanQuest/.test(String(title)), String(title));
    room.close();
  }

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  main.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
