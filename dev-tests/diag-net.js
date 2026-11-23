'use strict';
const PORT = Number(process.argv[2] || 9224);

(async () => {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
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
      const t = setTimeout(() => res('TIMEOUT'), 10000);
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
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression: expr, awaitPromise: true, returnByValue: true },
        })
      );
    });

  console.log('api.netPack   :', await ev('typeof window.api.netPack'));
  console.log('api.netUnpack :', await ev('typeof window.api.netUnpack'));
  console.log('api.netCreate :', await ev('typeof window.api.netCreate'));
  console.log('pqNet         :', await ev('typeof window.pqNet'));
  console.log('mode          :', await ev('window.pqNet._internal.state.mode'));
  console.log('pack          :', await ev('window.api.netPack({t:"x",a:1}).then(r => r.ok + "|" + r.len)'));
  console.log('codeBox exists:', await ev('!!document.getElementById("net-code-box")'));
  console.log('body html len :', await ev('(document.getElementById("net-body")||{}).innerHTML ? document.getElementById("net-body").innerHTML.length : -1'));
  ws.close();
})().catch((e) => console.error('DIAG ERR', e.message));
