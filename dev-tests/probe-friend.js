'use strict';
const target = 'http://127.0.0.1:9348';
(async () => {
  const list = await (await fetch(target + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r));
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result && r.result.result && r.result.result.value;
    function send(method, params) { return new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); }); }
  };
  await ev(`document.querySelector('[data-view="friends"]').click(); 1`);
  await new Promise((r) => setTimeout(r, 400));
  console.log('h2:', JSON.stringify(await ev(`($('#view h2')||{}).textContent||'MISSING'`)));
  console.log('viewlen:', await ev(`$('#view').textContent.length`));
  console.log('viewhead:', JSON.stringify(String(await ev(`$('#view').textContent`)).slice(0, 120)));
  await ev(`window.api.planSandboxDrop(); 1`);
  const imp = await ev(`window.api.planfileImportText({ text: JSON.stringify({ magic: 'PLANQUEST-PLAN', format: 1, data: { plans: [{ id: 'p-x', title: 'X', kind: 'plan', status: 'todo' }], logs: [], goals: [], contracts: [], shop: [] } }), from:'u', fromAlias:'U' })`);
  console.log('import:', JSON.stringify(imp));
  const promo = await ev(`window.api.planSandboxPromote()`);
  console.log('promote:', JSON.stringify(promo));
  ws.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
