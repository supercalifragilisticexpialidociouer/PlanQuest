/* 好友区测试：F0 结缘门禁 / F1 搭子限额与完成率门 / F2 战友升降 / 24h 焚毁 */
'use strict';

const assert = require('assert');
const F = require('../src/friend');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail += 1;
    console.log('  ✗ ' + name + ' → ' + e.message);
  }
}

const T0 = 1700000000000;
const DAY = 24 * 3600e3;

console.log('\n[1] 结缘：三条正路 + 问答门禁');
ok('不写 via 不能结缘', () => assert.equal(F.bond('u1', '小明', '', T0).ok, false));
ok('双人自习室结缘 → F1', () => {
  const r = F.bond('u1', '小明', 'room', T0);
  assert.equal(r.ok, true);
  assert.equal(r.friend.tier, 1);
  assert.equal(F.tierText(r.friend), '搭子档');
});
ok('对赌契约也能结缘', () => assert.equal(F.bond('u1', '', 'contract', T0).friend.tier, 1));
ok('门禁题量限制 1~5', () => assert.equal(F.makeGate('u1', '', [], T0).ok, false));
ok('5 题以上拒收', () => assert.equal(F.makeGate('u1', '', Array(6).fill({ q: 'x', a: 'y' }), T0).ok, false));
{
  const g = F.makeGate('u1', '小明', [{ q: '我们的房间码是多少', a: '1234' }, { q: '上次契约押金', a: '50' }], T0).gate;
  ok('答错一题就不放行', () => {
    const r = F.answerGate(g, ['9999', '50']);
    assert.equal(r.pass, false);
    assert.equal(g.status, 'fail');
  });
  ok('全对才放行（忽略大小写标点）', () => {
    const g2 = F.makeGate('u1', '', [{ q: 'q', a: 'Abc-123' }], T0).gate;
    const r = F.answerGate(g2, ['abc123']);
    assert.equal(r.pass, true);
  });
  ok('处理过的申请不能重复判', () => assert.equal(F.answerGate(g, ['1234', '50']).ok, false));
}

console.log('\n[2] F0 不能私信');
ok('未结缘拒绝一切私信', () => {
  const r = F.canSend(null, T0, { kind: 'text', myRate: 100, peerRate: 100 });
  assert.equal(r.ok, false);
  assert.ok(/结缘/.test(r.reason));
});

console.log('\n[3] F1 搭子档：完成率门 + 限额 + 焚毁');
{
  const f = F.bond('u1', '小明', 'room', T0).friend;
  ok('我摆烂不能发（先各自干活）', () => {
    const r = F.canSend(f, T0, { kind: 'text', myRate: 30, peerRate: 80 });
    assert.equal(r.ok, false);
    assert.ok(/先各自干活/.test(r.reason));
    assert.equal(r.gate, true);
  });
  ok('对方摆烂也不能发', () => assert.equal(F.canSend(f, T0, { kind: 'text', myRate: 80, peerRate: 49 }).ok, false));
  ok('双方都 ≥50 才放行', () => assert.equal(F.canSend(f, T0, { kind: 'text', myRate: 50, peerRate: 50 }).ok, true));
  ok('F1 禁图片/文件/外部链接/表情', () => {
    for (const k of ['image', 'file', 'exturl', 'emoji']) {
      assert.equal(F.canSend(f, T0, { kind: k, myRate: 80, peerRate: 80 }).ok, false, k);
    }
  });
  ok('F1 禁打卡截图和计划包（F2 权限）', () => {
    assert.equal(F.canSend(f, T0, { kind: 'shot', myRate: 80, peerRate: 80 }).ok, false);
    assert.equal(F.canSend(f, T0, { kind: 'plan', myRate: 80, peerRate: 80 }).ok, false);
  });
  ok('每天 20 条：第 21 条拒', () => {
    const g = JSON.parse(JSON.stringify(f));
    for (let i = 0; i < 20; i++) assert.equal(F.send(g, T0, { kind: 'text', myRate: 80, peerRate: 80 }).ok, true, i);
    const r = F.send(g, T0, { kind: 'text', myRate: 80, peerRate: 80 });
    assert.equal(r.ok, false);
    assert.ok(/额度/.test(r.reason));
  });
  ok('次日额度重置', () => {
    const g = JSON.parse(JSON.stringify(f));
    for (let i = 0; i < 20; i++) F.send(g, T0, { kind: 'text', myRate: 80, peerRate: 80 });
    assert.equal(F.quotaLeft(g, T0 + DAY, true), 20);
  });
  ok('双向限额各自算', () => {
    const g = JSON.parse(JSON.stringify(f));
    F.tickQuota(g, T0, false);
    assert.equal(F.quotaLeft(g, T0, false), 19);
    assert.equal(F.quotaLeft(g, T0, true), 20);
  });
}

console.log('\n[4] F2 战友档：全勤升级 / 断勤降档 / 解缘');
{
  const d = F.dayKey(T0);
  const mk = (uid) => F.bond(uid, '', 'room', T0).friend;
  ok('双方全勤记晋升（次日兑现）', () => {
    const f = mk('a1');
    F.settleDay(f, d, true);
    assert.equal(f.tier, 1);
    assert.equal(f.promoteDay, F.nextDayKey(d));
  });
  ok('次日保持全勤 → 升级 F2', () => {
    const f = mk('a2');
    F.settleDay(f, d, true);
    F.settleDay(f, F.nextDayKey(d), true);
    assert.equal(f.tier, 2);
    assert.equal(F.tierText(f), '战友档');
  });
  ok('晋升当天就断勤 → 退回 F1（全勤续期）', () => {
    const f = mk('a3');
    F.settleDay(f, d, true);
    const r = F.settleDay(f, F.nextDayKey(d), false);
    assert.equal(f.tier, 1);
    assert.ok(/退回搭子档/.test(r.note));
    assert.equal(f.slump, 1);
  });
  ok('F2 额度 50 条 + 打卡截图/计划包/表情', () => {
    const f = mk('a4');
    F.settleDay(f, d, true);
    F.settleDay(f, F.nextDayKey(d), true);
    assert.equal(F.quotaLeft(f, T0, true), 50);
    for (const k of ['shot', 'plan', 'emoji']) {
      assert.equal(F.canSend(f, T0, { kind: k, myRate: 100, peerRate: 100 }).ok, true, k);
    }
  });
  ok('连续 3 天断勤 → 自动解缘回 F0', () => {
    const g = mk('a5');
    F.settleDay(g, d, true);
    F.settleDay(g, F.nextDayKey(d), true);
    F.settleDay(g, F.nextDayKey(F.nextDayKey(d)), false); // 退 F1, slump=1
    F.settleDay(g, F.nextDayKey(F.nextDayKey(F.nextDayKey(d))), false); // slump=2
    const r = F.settleDay(g, F.nextDayKey(F.nextDayKey(F.nextDayKey(F.nextDayKey(d)))), false);
    assert.equal(r.unbond, true);
    assert.equal(g.tier, 0);
    assert.ok(/解缘/.test(r.note));
  });
  ok('断勤后重新全勤 → 断勤清零、重新排晋升', () => {
    const g = mk('a6');
    F.settleDay(g, d, true);
    F.settleDay(g, F.nextDayKey(d), true);
    F.settleDay(g, F.nextDayKey(F.nextDayKey(d)), false);
    const r = F.settleDay(g, F.nextDayKey(F.nextDayKey(F.nextDayKey(d))), true);
    assert.equal(g.slump, 0);
    assert.ok(g.promoteDay);
    assert.equal(r.unbond, undefined);
  });
}

console.log('\n[5] 24h 消息焚毁');
ok('焚毁时间 = 发送时刻 + 24h', () => {
  const m = F.makeMsg('u1', '我', '在吗', T0, 'text');
  assert.equal(m.burnAt, T0 + DAY);
  assert.equal(F.burnLeft(m, T0 + 3600e3), DAY - 3600e3);
});
ok('过期消息被清掉，活着的保留', () => {
  const ms = [F.makeMsg('u1', '', 'a', T0), F.makeMsg('u1', '', 'b', T0 + DAY - 1000), F.makeMsg('u1', '', 'c', T0 + DAY + 1000)];
  const live = F.pruneBurned(ms, T0 + DAY);
  assert.equal(live.length, 2);
  assert.equal(live[0].text, 'b');
});
ok('本地缓存最多 200 条', () => {
  const ms = [];
  for (let i = 0; i < 300; i++) ms.push(F.makeMsg('u1', '', 'm' + i, T0 + i * 1000));
  assert.equal(F.pruneBurned(ms, T0).length, 200);
});

console.log('\n[9] 任务排行 / 互相契约 / 自动提醒');
{
  ok('排行：按完成率降序，我带 isMe 标记', () => {
    const rows = F.ranking({ a: { alias: '阿甲', peerRate: 80 }, b: { alias: '阿乙', peerRate: 95 } }, 60, '我');
    assert.equal(rows.length, 3);
    assert.equal(rows[0].alias, '阿乙');
    assert.equal(rows[1].alias, '阿甲');
    assert.equal(rows[2].isMe, true);
    assert.equal(rows[2].rank, 3);
  });
  ok('排行：完成率夹在 0~100，平分按昵称序', () => {
    const rows = F.ranking({ a: { alias: '乙', peerRate: 150 }, b: { alias: '甲', peerRate: -5 } }, 70, '我');
    assert.equal(rows[0].rate, 100);
    assert.equal(rows[1].isMe, true);
    assert.equal(rows[1].rate, 70);
    assert.equal(rows[2].rate, 0);
    assert.equal(rows[2].alias, '甲');
  });
  ok('契约：能立，押金/天数夹紧', () => {
    const f = F.bond('pc1', '', 'room', T0).friend;
    const bad = F.makePact(f, { deposit: 0, days: 5 }, T0);
    assert.equal(bad.ok, false);
    const r = F.makePact(f, { deposit: 999, days: 99 }, T0);
    assert.equal(r.ok, true);
    assert.equal(r.pact.deposit, F.PACT.MAX_DEPOSIT);
    assert.equal(r.pact.days, F.PACT.MAX_DAYS);
    assert.equal(r.pact.endDay, F.shiftDay(F.dayKey(T0), F.PACT.MAX_DAYS));
  });
  ok('契约：生效中不能重复立', () => {
    const f = F.bond('pc2', '', 'room', T0).friend;
    F.makePact(f, { deposit: 30, days: 5 }, T0);
    const r = F.makePact(f, { deposit: 10, days: 5 }, T0);
    assert.equal(r.ok, false);
  });
  ok('契约：漏卡累计，到期按天扣（全勤全退）', () => {
    const f1 = F.bond('pc3', '', 'room', T0).friend;
    F.makePact(f1, { deposit: 30, days: 3 }, T0);
    const d = F.dayKey(T0);
    let r = F.pactTick(f1, d, false, T0);
    assert.equal(r.ended, false);
    assert.equal(r.missed, 1);
    r = F.pactTick(f1, F.nextDayKey(d), false, T0);
    r = F.pactTick(f1, F.nextDayKey(F.nextDayKey(d)), false, T0);
    assert.equal(r.ended, true);
    assert.equal(r.missed, 3);
    assert.equal(r.penalty, 30); // ceil(30/3)=10 × 3 天
    assert.equal(r.refund, 0);
    assert.equal(r.pass, false);
    assert.equal(f1.pact.status, 'done');
    const f2 = F.bond('pc4', '', 'room', T0).friend;
    F.makePact(f2, { deposit: 30, days: 3 }, T0);
    let r2 = null;
    for (let i = 0; i < 3; i++) r2 = F.pactTick(f2, F.shiftDay(F.dayKey(T0), i), true, T0);
    assert.equal(r2.ended, true);
    assert.equal(r2.penalty, 0);
    assert.equal(r2.refund, 30);
    assert.equal(r2.pass, true);
  });
  ok('契约：同一天重复记账不算两遍', () => {
    const f = F.bond('pc5', '', 'room', T0).friend;
    F.makePact(f, { deposit: 30, days: 5 }, T0);
    const d = F.dayKey(T0);
    F.pactTick(f, d, false, T0);
    const r = F.pactTick(f, d, false, T0);
    assert.equal(r.unchanged, true);
    assert.equal(f.pact.missed, 1);
  });
  ok('契约：提前结算，漏的天照样扣', () => {
    const f = F.bond('pc6', '', 'room', T0).friend;
    F.makePact(f, { deposit: 40, days: 10 }, T0);
    F.pactTick(f, F.dayKey(T0), false, T0);
    const r = F.pactSettle(f, T0);
    assert.equal(r.ok, true);
    assert.equal(r.early, true);
    assert.equal(r.penalty, 4); // ceil(40/10)=4 × 1 天
    assert.equal(r.refund, 36);
  });
  ok('提醒：21 点前不提醒', () => {
    const f = F.bond('rm1', '', 'room', T0).friend;
    const t9 = new Date(T0); t9.setHours(20, 0, 0, 0);
    assert.equal(F.shouldRemind(f, t9.getTime(), 3), false);
  });
  ok('提醒：21 点后有剩任务才提醒，且每天一次', () => {
    const f = F.bond('rm2', '', 'room', T0).friend;
    const t9 = new Date(T0); t9.setHours(21, 30, 0, 0);
    assert.equal(F.shouldRemind(f, t9.getTime(), 0), false); // 没剩任务
    assert.equal(F.shouldRemind(f, t9.getTime(), 2), true);
    assert.equal(F.shouldRemind(f, t9.getTime() + 60000, 2), false); // 当天第二次
    const next = new Date(t9); next.setDate(next.getDate() + 1);
    assert.equal(F.shouldRemind(f, next.getTime(), 1), true);
  });
  ok('提醒：F0 不提醒；文案带剩余数', () => {
    const f = F.bond('rm3', '', 'room', T0).friend;
    f.tier = 0;
    const t9 = new Date(T0); t9.setHours(21, 0, 0, 0);
    assert.equal(F.shouldRemind(f, t9.getTime(), 2), false);
    assert.ok(/3 项/.test(F.remindText(3)));
  });
}

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + `：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
