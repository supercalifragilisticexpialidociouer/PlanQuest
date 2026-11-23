'use strict';

/* 异地军团端到端实测：
 *   A（房主）创建异地军团 → 生成邀请码
 *   B（成员）粘贴邀请码 → 生成回执码
 *   A 粘贴回执码 → WebRTC DataChannel 建立
 *   B 上报 → A 聚合 → B 收到 agg
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const getJson = (u) =>
  new Promise((res, rej) =>
    http
      .get(u, (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => res(JSON.parse(b)));
      })
      .on('error', rej)
  );

async function conn(port) {
  const list = await getJson('http://127.0.0.1:' + port + '/json');
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error('找不到页面 ' + port);
  const ws = await new Promise((r, j) => {
    const w = new WebSocket(page.webSocketDebuggerUrl);
    w.onopen = () => r(w);
    w.onerror = () => j(new Error('ws 失败'));
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
  const shot = async (f) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  };
  return { ws, send, ev, shot };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const A = await conn(9361);
  const B = await conn(9362);

  console.log('[0] 清空本地状态并重载（排除历史残留）');
  await A.ev('try{localStorage.clear()}catch(e){}');
  await B.ev('try{localStorage.clear()}catch(e){}');
  await A.send('Page.reload', { ignoreCache: true });
  await B.send('Page.reload', { ignoreCache: true });
  await sleep(4500);

  console.log('[1] 两边都进军团页');
  await A.ev('switchView("legion")');
  await B.ev('switchView("legion")');
  await sleep(600);

  console.log('[2] A 创建异地军团');
  const created = await A.ev(`(async () => {
    PQLegion.leave();
    await new Promise(r => setTimeout(r, 200));
    const r = await PQLegion.create({ alias: '甲', net: 'p2p' });
    return JSON.stringify(r);
  })()`);
  console.log('  create:', created);
  const c = JSON.parse(created);
  if (!c.ok) throw new Error('创建失败');

  console.log('[3] A 生成邀请码');
  const invite = await A.ev(`(async () => {
    const r = await PQLegionNet.invite();
    return r.ok ? r.text : 'ERR:' + r.message;
  })()`);
  console.log('  邀请码长度:', String(invite).length, String(invite).slice(0, 40) + '…');
  if (String(invite).startsWith('ERR')) throw new Error(invite);

  console.log('[4] B 粘贴邀请码 → 回执码');
  const reply = await B.ev(`(async () => {
    const r = await PQLegion.joinP2P({ invite: ${JSON.stringify(invite)}, alias: '乙' });
    return r.ok ? r.text : 'ERR:' + r.message;
  })()`);
  console.log('  回执码长度:', String(reply).length, String(reply).slice(0, 40) + '…');
  if (String(reply).startsWith('ERR')) throw new Error(reply);

  console.log('[5] A 粘贴回执码');
  const applied = await A.ev(`(async () => {
    const r = await PQLegionNet.applyReply(${JSON.stringify(reply)});
    return JSON.stringify(r);
  })()`);
  console.log('  applyReply:', applied);

  console.log('[6] 等连接建立');
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    const ia = await A.ev('JSON.stringify(PQLegionNet.info())');
    const ib = await B.ev('JSON.stringify(PQLegionNet.info())');
    const a = JSON.parse(ia);
    const b = JSON.parse(ib);
    if (a.online > 0 && b.memberOnline) {
      console.log('  连上了 · 房主在线成员', a.online, '· 成员通道', b.state);
      break;
    }
    if (i === 19) console.log('  未连上：', ia, ib);
  }

  console.log('[7] B 上报一次');
  const push = await B.ev(`(async () => {
    const r = await PQLegion.syncNow({ force: true });
    return JSON.stringify(r);
  })()`);
  console.log('  B sync:', push);

  await sleep(1500);

  const aggA = JSON.parse(await A.ev('JSON.stringify(PQLegion.info().agg||{})'));
  const aggB = JSON.parse(await B.ev('JSON.stringify(PQLegion.info().agg||{})'));
  console.log('  A 侧概况:', JSON.stringify({ n: aggA.n, today: aggA.today, rate: aggA.rate, rescue: aggA.rescue }));
  console.log('  B 侧概况:', JSON.stringify({ n: aggB.n, today: aggB.today, rate: aggB.rate }));

  console.log('[8] B 点一盏灯');
  const lamp = await B.ev(`(async () => JSON.stringify(await PQLegion.lamp()))()`);
  console.log('  lamp:', lamp);
  await sleep(1200);
  const aggA2 = JSON.parse(await A.ev('JSON.stringify(PQLegion.info().agg||{})'));
  console.log('  A 侧救援值:', aggA2.rescue);

  const ia = JSON.parse(await A.ev('JSON.stringify(PQLegion.info())'));
  const ib = JSON.parse(await B.ev('JSON.stringify(PQLegion.info())'));
  console.log('  A 个人位置:', ia.you || '(未收到)', '· 热度:', ia.heat);
  console.log('  B 个人位置:', ib.you || '(未收到)', '· 热度:', ib.heat);

  const pts = await B.ev('JSON.stringify((window.state && state.profile) ? { points: state.profile.points } : {})');
  console.log('  B 当前积分:', pts);

  await A.ev('renderLegion()');
  await B.ev('renderLegion()');
  await sleep(500);
  await A.shot(path.join(__dirname, '..', 'shots', 'lg-p2p-host.png'));
  await B.shot(path.join(__dirname, '..', 'shots', 'lg-p2p-member.png'));
  console.log('截图已存 shots/lg-p2p-host.png / lg-p2p-member.png');

  A.ws.close();
  B.ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
