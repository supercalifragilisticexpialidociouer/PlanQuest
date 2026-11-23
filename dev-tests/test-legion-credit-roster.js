/* 军团成员目录 · 信誉分随握手带上
 *
 * 为什么要测：团内要显示「昵称 + 大概的信誉等级」，但信誉分明细不能外泄。
 * 规则是「只报分值、不报明细」——hallo 带 credit，房主存进成员表，snapshot 下发。
 */
'use strict';

function fresh() {
  const p = require.resolve('../src/legion-room.js');
  delete require.cache[p];
  return require(p);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let pass = 0;
  let fail = 0;
  const ck = (name, cond, extra) => {
    if (cond) {
      pass++;
      console.log('  ✓', name);
    } else {
      fail++;
      console.log('  ✗', name, extra === undefined ? '' : JSON.stringify(extra));
    }
  };

  const host = fresh();
  const hb = await host.createLegion({ code: 'CR12', alias: '团长', uid: 'u-host', credit: 128 });
  ck('团长建团', hb.ok === true, hb);
  const hs = host.snapshot();
  const hself = (hs.members || []).find((m) => m.uid === 'u-host');
  ck('团长自己的信誉分在目录里', !!(hself && hself.credit === 128), hself);

  const mate = fresh();
  const jb = await mate.joinLegion({
    ip: '127.0.0.1',
    port: hb.port,
    code: 'CR12',
    alias: '小明',
    uid: 'u-min',
    credit: 86,
  });
  ck('成员加入', jb.ok === true, jb);
  await sleep(150);

  const after = host.snapshot();
  const mrow = (after.members || []).find((m) => m.uid === 'u-min');
  ck('成员信誉分同步到房主目录', !!(mrow && mrow.credit === 86), mrow);
  ck('目录里有昵称', !!(mrow && mrow.alias === '小明'), mrow);
  ck('只带分值不带明细', !!(mrow && Object.keys(mrow).sort().join(',') === 'alias,credit,lastAt,online,self,uid'), mrow);

  /* 没报信誉分的老客户端：给 null，界面显示「等级未知」，不瞎猜 */
  const old = fresh();
  await old.joinLegion({ ip: '127.0.0.1', port: hb.port, code: 'CR12', alias: '老版本', uid: 'u-old' });
  await sleep(150);
  const o = (host.snapshot().members || []).find((m) => m.uid === 'u-old');
  ck('没报分就是 null', !!(o && o.credit === null), o);

  /* 重新握手会刷新分值（信誉分是会变的） */
  await mate.leaveLegion(true);
  await sleep(80);
  const mate2 = fresh();
  await mate2.joinLegion({
    ip: '127.0.0.1',
    port: hb.port,
    code: 'CR12',
    alias: '小明',
    uid: 'u-min',
    credit: 61,
  });
  await sleep(150);
  const refreshed = (host.snapshot().members || []).find((m) => m.uid === 'u-min');
  ck('再次握手刷新分值', !!(refreshed && refreshed.credit === 61), refreshed);

  host.leaveLegion(true);
  mate2.leaveLegion(true);
  await sleep(50);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
