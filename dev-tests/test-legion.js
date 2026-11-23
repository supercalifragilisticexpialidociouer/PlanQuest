'use strict';

/* 军团自测（v2 · 四态协议 + 双通道）
 *
 * 覆盖：
 *   1) 未加入时任何上报都被拒绝（不发包）
 *   2) 白名单裁剪：只留 day/checked/force/neg，计划名/金额/备注/积分一律丢弃
 *   3) 局域网：建团 → 成员加入 → 上报 → 聚合四态计数
 *   4) 异地枢纽：startHub → absorb → aggNow（与局域网同一套聚合口径）
 *   5) 点灯与熔断：救援值累加、熔断关掉徽章发放
 */

require('node:path');

function fresh() {
  const p = require.resolve('../src/legion-room.js');
  delete require.cache[p];
  return require(p);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

  console.log('[1] 未加入时不能推');
  const lone = fresh();
  const r0 = lone.pushBundle({ day: today(), checked: 1 });
  ck('未加入 push 被拒', !r0 || r0.ok === false, r0);
  const a0 = lone.absorb({ uid: 'x', bundle: { day: today(), checked: 1 } });
  ck('未加入 absorb 被拒', !a0 || a0.ok === false, a0);

  console.log('[2] 白名单裁剪（v2 四态）');
  const host = fresh();
  const c = await host.createLegion({ code: 'AB12', alias: '房主' });
  ck('建团成功', c.ok === true, c);
  ck('拿到端口', c.port > 0, c.port);

  const dirty = {
    day: today(),
    checked: 1,
    force: 1,
    neg: 1,
    // 以下全部不该出现在摘要里
    planName: '绝不能外发的计划名',
    amount: 500,
    note: '私人备注',
    points: 12345,
    focusSec: 3600,
    camera: 'frame-data',
  };
  const snap = host.sanitizeBundle(dirty);
  ck('只剩 4 个状态 + 版本/日期', Object.keys(snap).sort().join(',') === 'checked,day,force,neg,v', snap);
  ck('计划名被丢弃', snap.planName === undefined);
  ck('金额被丢弃', snap.amount === undefined);
  ck('备注被丢弃', snap.note === undefined);
  ck('积分被丢弃', snap.points === undefined);
  ck('时长被丢弃', snap.focusSec === undefined);
  ck('摄像头字段被丢弃', snap.camera === undefined);
  ck('状态位正常', snap.checked === 1 && snap.force === 1 && snap.neg === 1, snap);

  console.log('[3] 局域网：成员加入并上报');
  const cli = fresh();
  const j = await cli.joinLegion({ ip: '127.0.0.1', port: c.port, code: 'AB12', alias: '同路人', uid: 'u-test-1' });
  ck('成员加入成功', j.ok === true, j);
  await sleep(250);

  const p1 = cli.pushBundle({ day: today(), checked: 1, force: 0, neg: 0 });
  ck('成员上报成功', p1.ok === true, p1);
  await sleep(250);

  host.pushBundle({ day: today(), checked: 0, force: 1, neg: 1 });
  await sleep(250);

  let agg = host.aggNow();
  ck('聚合两人', agg.n === 2, agg.n);
  ck('已打卡 1 人', agg.today.checked === 1, agg.today);
  ck('未打卡 1 人', agg.today.unchecked === 1, agg.today);
  ck('强制模式 1 人', agg.today.force === 1, agg.today);
  ck('负分挣扎 1 人', agg.today.neg === 1, agg.today);
  ck('出操率档位为 1（零星）', agg.rate === 1, agg.rate);
  ck('不含任何时长/积分字段', agg.focus === undefined && agg.pts === undefined);
  ck('周目标 = 人数 × 5', agg.challenge.target === 10, agg.challenge);

  console.log('[4] 点灯 / 熔断 / 日志');
  host.lightLamp();
  host.lightLamp();
  agg = host.aggNow();
  ck('救援值累加', agg.rescue === 2, agg.rescue);
  ck('日志有事件', Array.isArray(agg.log) && agg.log.length >= 2, agg.log && agg.log.length);

  host.setMuted(true);
  agg = host.aggNow();
  ck('熔断状态可见', agg.muted === true, agg.muted);
  host.setMuted(false);

  console.log('[5] 异地枢纽：与局域网同一套聚合');
  const hub = fresh();
  const h = hub.startHub({ code: 'P2P1', alias: '异地房主', uid: 'u-hub' });
  ck('枢纽启动', h.ok === true, h);

  const t = today();
  const ab1 = hub.absorb({ uid: 'u-a', alias: 'A', bundle: { day: t, checked: 1 } });
  const ab2 = hub.absorb({ uid: 'u-b', alias: 'B', bundle: { day: t, checked: 0, neg: 1 } });
  const ab3 = hub.absorb({ uid: 'u-c', alias: 'C', bundle: { day: t, checked: 1, force: 1 } });
  ck('三次吸收都成功', ab1.ok && ab2.ok && ab3.ok);
  ck('absorb 直接返回聚合', !!ab3.agg);

  hub.pushBundle({ day: t, checked: 1 }); // 房主自己
  const hagg = hub.aggNow();
  ck('枢纽聚合三人次 + 房主 = 4', hagg.n === 4, hagg.n);
  ck('已打卡 3 人', hagg.today.checked === 3, hagg.today);
  ck('负分 1 人', hagg.today.neg === 1, hagg.today);

  console.log('[6] 退出清理');
  host.leaveLegion(true);
  const after = host.aggNow();
  ck('退出后房主不再聚合', !after || after.n === 0, after && after.n);
  hub.leaveLegion(true);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试崩溃', e);
  process.exit(1);
});
