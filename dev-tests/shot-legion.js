'use strict';

/* 军团页截图：未加入 → 创建 → 假成员上报 → 有数据 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.PQ_DEBUG_PORT || 9333);

async function getJson(url) {
  return new Promise((resolve, reject) => {
    require('node:http')
      .get(url, (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function conn(port, re) {
  const list = await getJson('http://127.0.0.1:' + port + '/json');
  const page = list.find((t) => t.type === 'page' && re.test(t.url));
  if (!page) throw new Error('no page');
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
  const ev = (expr) =>
    send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) =>
      r && r.result ? r.result.value : undefined
    );
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
const out = path.join(__dirname, '..', 'shots');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const A = await conn(PORT, /index\.html/);

  const errs = await A.ev('(window.__lgErr || []).join(" | ")');
  await A.ev('switchView("legion")');
  await sleep(700);
  await A.shot(path.join(out, 'lg-1-intro.png'));
  console.log('lg-1-intro.png');

  const ok = await A.ev(`
    (async () => {
      document.querySelector('#lg-create').click();
      await new Promise(r => setTimeout(r, 200));
      document.querySelector('#lg-create-go').click();
      await new Promise(r => setTimeout(r, 1200));
      return JSON.stringify(window.PQLegion.info());
    })()
  `);
  console.log('create ->', ok);
  const info = JSON.parse(ok || '{}');
  if (!info.joined) {
    console.log('FAIL 创建没成功');
    A.close();
    process.exit(1);
  }

  await sleep(500);
  await A.shot(path.join(out, 'lg-2-joined.png'));
  console.log('lg-2-joined.png');

  // 两个假成员，分别「大半」和「全清」
  const file = path.join(__dirname, 'legion-fake-member.js');
  const run = (band, alias) =>
    new Promise((r) => execFile(process.execPath, [file, String(info.port), info.code, String(band), alias], () => r()));
  await Promise.all([run(2, '同路人A'), run(3, '同路人B')]);
  await sleep(1200);

  await A.ev('renderLegion()');
  await sleep(500);
  await A.shot(path.join(out, 'lg-3-data.png'));
  console.log('lg-3-data.png');

  const agg = await A.ev('JSON.stringify((window.PQLegion.info().agg)||{})');
  console.log('agg ->', agg);
  A.close();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
