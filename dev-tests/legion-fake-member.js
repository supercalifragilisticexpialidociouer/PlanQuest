'use strict';

/* 假军团成员：连上房主，推一份摘要，停留 8 秒后退出。
 * 用法：node dev-tests/legion-fake-member.js <port> <code> <band> <alias>
 */

const path = require('node:path');
const mod = require(path.join(__dirname, '..', 'src', 'legion-room.js'));

const [port, code, band, alias] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

(async () => {
  const r = await mod.joinLegion({
    ip: '127.0.0.1',
    port: Number(port),
    code: String(code || ''),
    alias: String(alias || '同路人'),
    uid: 'u-fake-' + Math.random().toString(36).slice(2, 8),
  });
  console.log('join', JSON.stringify(r));
  if (!r.ok) process.exit(1);

  const b = {
    v: 1,
    day: today(),
    band: Number(band) || 1,
    streak: 3,
    focus: 2,
    pts: 2,
    busy: 1,
  };
  console.log('push', JSON.stringify(mod.pushBundle(b)));
  await sleep(8000);
  mod.leaveLegion(true);
  process.exit(0);
})();
