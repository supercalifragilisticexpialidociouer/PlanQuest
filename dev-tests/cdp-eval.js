/* 用 Node 内置 WebSocket 连 CDP，跑几段表达式做 UI 冒烟 */
'use strict';

const target = process.argv[2] || 'http://127.0.0.1:9333';
const exprs = JSON.parse(process.argv[3] || '[]');

(async () => {
  const list = await (await fetch(target + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params) =>
    new Promise((res) => {
      const n = ++id;
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  await send('Runtime.enable');
  for (const expr of exprs) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const v = r.result && r.result.result;
    console.log('---', expr.slice(0, 70).replace(/\n/g, ' '));
    console.log(JSON.stringify(v && (v.value !== undefined ? v.value : v.description || v.type)));
  }
  ws.close();
})();
