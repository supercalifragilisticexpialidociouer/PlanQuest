/* PlanQuest · 军团纪律引擎测试（v2.6）
 * 跑法：node dev-tests/test-discipline-v26.js
 */
'use strict';

const assert = require('assert');
const D = require('../src/legion-discipline');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + '  →  ' + e.message);
  }
}

const MIN = 60e3;

console.log('\n— 逃兵 —');
ok('正常专注不判逃', () => {
  const v = D.desertVerdict({ minutes: 25, awayMs: 5000, leaves: 0, guardHits: 0 });
  assert.equal(v.level, 'ok');
  assert.equal(v.penalty, 0);
});

ok('切出去 40 秒 → 提醒不扣分', () => {
  const v = D.desertVerdict({ minutes: 25, awayMs: 40e3, leaves: 1, guardHits: 0 });
  assert.equal(v.level, 'warn');
  assert.equal(v.penalty, 0);
  assert.ok(/保护你自己/.test(v.note));
});

ok('切出去 2 分钟 → 逃兵，扣分', () => {
  const v = D.desertVerdict({ minutes: 25, awayMs: 2 * MIN, leaves: 1, guardHits: 0 });
  assert.equal(v.level, 'desert');
  assert.ok(v.penalty >= 3);
});

ok('开课 3 分钟就切走不算逃', () => {
  const v = D.desertVerdict({ minutes: 3, awayMs: 2 * MIN, leaves: 3, guardHits: 2 });
  assert.equal(v.level, 'ok');
});

ok('命中干扰进程 2 次 → 逃兵', () => {
  const v = D.desertVerdict({ minutes: 25, awayMs: 0, leaves: 0, guardHits: 2 });
  assert.equal(v.level, 'desert');
});

ok('逃得越久扣得越多，但封顶 3 倍', () => {
  const a = D.desertVerdict({ minutes: 50, awayMs: 6 * MIN, leaves: 1, guardHits: 0 });
  const b = D.desertVerdict({ minutes: 50, awayMs: 60 * MIN, leaves: 4, guardHits: 4 });
  assert.ok(b.penalty >= a.penalty);
  assert.ok(b.penalty <= D.LIMITS.desertPenalty * 3);
});

ok('欠分到 -10 → 冻结军团资格', () => {
  const d = {};
  const v = D.desertVerdict({ minutes: 25, awayMs: 3 * MIN, leaves: 1, guardHits: 0 });
  D.applyDesert(d, v, { creditAfter: -10, now: 1000 });
  assert.ok(d.frozenUntil > 1000);
  const st = D.stateOf({ credit: -10, discipline: d, now: 2000 });
  assert.equal(st.frozen, true);
  assert.equal(st.canJoinLegion, false);
});

console.log('\n— 刷分狗 —');
ok('短专注（<15 分钟）不判定', () => {
  const a = D.focusAudit({ minutes: 10, buckets: [0, 0], mouseMoves: 0, keyPresses: 0 });
  assert.equal(a.level, 'ok');
});

ok('正常使用不误伤', () => {
  const a = D.focusAudit({
    minutes: 30,
    focusMs: 29 * MIN,
    buckets: [12, 3, 9, 0, 4, 6],
    mouseMoves: 120,
    keyPresses: 340,
    windowSwitches: 1,
  });
  assert.equal(a.level, 'ok');
});

ok('连续 15 分钟零操作 → 不计分', () => {
  const a = D.focusAudit({
    minutes: 30,
    focusMs: 30 * MIN,
    buckets: [10, 0, 0, 0, 0, 0],
    mouseMoves: 1,
    keyPresses: 0,
  });
  assert.equal(a.level, 'void');
  assert.equal(a.reason, 'idle');
});

ok('窗口大段时间在后台 → 不计分', () => {
  const a = D.focusAudit({
    minutes: 30,
    focusMs: 8 * MIN,
    buckets: [5, 4, 3, 2, 6, 1],
    mouseMoves: 60,
    keyPresses: 90,
  });
  assert.equal(a.level, 'void');
  assert.equal(a.reason, 'background');
});

ok('第 1 次挂机只作废，第 2 次开始扣分', () => {
  const d = {};
  const a = D.focusAudit({ minutes: 30, focusMs: 30 * MIN, buckets: [0, 0, 0, 0], mouseMoves: 0, keyPresses: 0 });
  const r1 = D.applyAudit(d, a, { now: 1 });
  assert.equal(r1.voided, true);
  assert.equal(r1.penalty, 0);
  const r2 = D.applyAudit(d, a, { now: 2 });
  assert.equal(r2.penalty, D.LIMITS.farmerStrikePenalty);
});

console.log('\n— 喷子 / 杠精 —');
ok('信誉 80 → 正常', () => {
  const s = D.speakVerdict({ credit: 80 });
  assert.equal(s.canSpeak, true);
  assert.equal(s.canPk, true);
});

ok('信誉 55 → 禁言但可 PK', () => {
  const s = D.speakVerdict({ credit: 55 });
  assert.equal(s.canSpeak, false);
  assert.equal(s.canPk, true);
});

ok('信誉 30 → 发言与 PK 全禁', () => {
  const s = D.speakVerdict({ credit: 30 });
  assert.equal(s.canSpeak, false);
  assert.equal(s.canPk, false);
});

ok('封禁优先于分数', () => {
  const s = D.speakVerdict({ credit: 150, banned: true });
  assert.equal(s.canSpeak, false);
  assert.equal(s.canPk, false);
});

console.log('\n— 鸽子精 —');
ok('没有见证人不能立契约', () => {
  const r = D.contractNew({ title: '背 50 个单词', deposit: 20, witness: '', dueAt: Date.now() + 3600e3, points: 100 });
  assert.equal(r.ok, false);
  assert.ok(/见证人/.test(r.message));
});

ok('押金不足 / 积分不够都拦住', () => {
  const t = Date.now() + 3600e3;
  assert.equal(D.contractNew({ title: 'x', deposit: 5, witness: '阿刺', dueAt: t, points: 100 }).ok, false);
  assert.equal(D.contractNew({ title: 'x', deposit: 20, witness: '阿刺', dueAt: t, points: 10 }).ok, false);
});

ok('正常立契', () => {
  const r = D.contractNew({ title: '背 50 个单词', deposit: 20, witness: '阿刺', dueAt: Date.now() + 3600e3, points: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.contract.status, 'open');
});

ok('完成 → 押金退回', () => {
  const r = D.contractSettle({ status: 'open', deposit: 30, witness: '阿刺', dueAt: Date.now() }, { done: true });
  assert.equal(r.refund, 30);
  assert.equal(r.penalty, 0);
});

ok('宽限期内不判违约', () => {
  const due = Date.now() - 3600e3;
  const r = D.contractSettle({ status: 'open', deposit: 30, witness: '阿刺', dueAt: due }, { done: false });
  assert.equal(r.ok, false);
});

ok('过了宽限期 → 押金没收 + 扣分', () => {
  const due = Date.now() - 24 * 3600e3;
  const r = D.contractSettle({ status: 'open', deposit: 30, witness: '阿刺', dueAt: due }, { done: false });
  assert.equal(r.status, 'failed');
  assert.equal(r.refund, 0);
  assert.equal(r.penalty, D.LIMITS.dovePenalty);
});

console.log('\n— 外挂 —');
ok('正常数据无异常', () => {
  const r = D.scanCheat({ focusMinutes: 300, credit: 120, pointsJump: 100 });
  assert.equal(r.ok, true);
});

ok('单日专注 1500 分钟 → 高危异常', () => {
  const r = D.scanCheat({ focusMinutes: 1500 });
  assert.equal(r.ok, false);
  assert.equal(r.hits[0].severity, 'high');
});

ok('点击间隔恒定 5ms → 模拟点击', () => {
  const r = D.scanCheat({ clickIntervalMs: 5, clickCount: 900 });
  assert.ok(r.hits.some((h) => h.kind === 'click_robot'));
});

ok('坐实 → 清零 + 永久封禁', () => {
  const r = D.reviewCheat({ kind: 'focus_over_day' }, { uphold: true });
  assert.equal(r.wipe, true);
  assert.equal(r.ban, true);
});

ok('误判 → 不动分', () => {
  const r = D.reviewCheat({ kind: 'focus_over_day' }, { uphold: false });
  assert.equal(r.wipe, false);
  assert.equal(r.ban, false);
});

console.log('\n— 综合状态 —');
ok('封禁的人不能加入军团', () => {
  const st = D.stateOf({ credit: 100, discipline: { ban: { permanent: true } }, now: 1 });
  assert.equal(st.canJoinLegion, false);
  assert.equal(st.canSpeak, false);
  assert.ok(st.reasons.length > 0);
});

ok('欠分 -5 未到冻结线，仍可入团但被禁言', () => {
  const st = D.stateOf({ credit: -5, discipline: {}, now: 1 });
  assert.equal(st.frozen, false);
  assert.equal(st.canSpeak, false);
  assert.equal(st.canJoinLegion, true); // -5 还在 -10 之上，军团资格未冻结
});

console.log('\n— 信誉分不可购买（硬断言）—');
ok('LIMITS 里没有「买分」通道', () => {
  const keys = Object.keys(D.LIMITS).join(',');
  assert.ok(!/buy|purchase|price|shop/i.test(keys));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
