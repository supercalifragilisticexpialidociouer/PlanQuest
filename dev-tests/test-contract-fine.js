/* 契约罚金核心回归：有任务可做且没做完才扣钱；无任务一分不扣。 */
'use strict';
const assert = require('node:assert/strict');
const F = require('../src/contract-fine');

let pass = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { console.error('  FAIL  ' + name + ' → ' + e.message); process.exitCode = 1; }
};

console.log('=== contract-fine 契约罚金 ===');

T('今天没排契约任务 → 一分钱不扣（即使罚金上限 10 元）', () => {
  const r = F.calc(10, 0, 0);
  assert.equal(r.due, 0);
  assert.equal(r.pct, null);
  assert.equal(r.owe, 0);
  assert.equal(r.fine, false);
});

T('有 2 个任务一个没做 → 顶格扣 ¥10', () => {
  const r = F.calc(10, 2, 0);
  assert.equal(r.due, 2);
  assert.equal(r.pct, 0);
  assert.equal(r.owe, 10);
  assert.equal(r.fine, true);
});

T('有任务但只做了一半 → 按完成度扣 ¥5', () => {
  const r = F.calc(10, 2, 1);
  assert.equal(r.pct, 50);
  assert.equal(r.owe, 5);
});

T('有任务且全做完 → 不扣钱', () => {
  const r = F.calc(10, 2, 2);
  assert.equal(r.pct, 100);
  assert.equal(r.owe, 0);
  assert.equal(r.fine, false);
});

T('罚金上限极低但没做完 → 至少 ¥1', () => {
  assert.equal(F.calc(1, 3, 2).owe, 1);
  assert.equal(F.calc(0.5, 3, 2).owe, 1);
});

T('done 超过 due 不会算出负罚金', () => {
  const r = F.calc(10, 2, 99);
  assert.equal(r.done, 2);
  assert.equal(r.owe, 0);
});

T('账本已结算金额与「已交」标记', () => {
  const s = { '2026-11-24': { owe: 4 }, '2026-11-23': { owe: 3 }, '2026-11-22': { owe: 0 } };
  const p = { '2026-11-24': true };
  assert.equal(F.settledTotal(s, p, false), 7);
  assert.equal(F.settledTotal(s, p, true), 3);
});

T('第一天：昨日账本 0 + 今日有任务没做 → 累计立刻显示 ¥10', () => {
  const today = F.calc(10, 2, 0);
  const m = F.combine({}, {}, '2026-11-25', today, false);
  assert.equal(m.settled, 0);
  assert.equal(m.todayOwe, 10);
  assert.equal(m.total, 10);      // 截图场景：原本这里错误地显示 ¥0
  assert.equal(m.unpaid, 10);
  assert.equal(m.fineToday, true);
});

T('今日补做完 → 今日罚金归零，累计只剩历史账本', () => {
  const s = { '2026-11-24': { owe: 4 } };
  const today = F.calc(10, 2, 2);
  const m = F.combine(s, {}, '2026-11-25', today, false);
  assert.equal(m.todayOwe, 0);
  assert.equal(m.total, 4);
});

T('今日本来就没任务 → 不新增罚金', () => {
  const m = F.combine({ '2026-11-24': { owe: 4 } }, {}, '2026-11-25', F.calc(10, 0, 0), false);
  assert.equal(m.todayOwe, 0);
  assert.equal(m.total, 4);
});

T('今日已结算过 → 不重复计入累计', () => {
  const s = { '2026-11-25': { owe: 7 } };
  const m = F.combine(s, {}, '2026-11-25', F.calc(10, 2, 0), true);
  assert.equal(m.todayOwe, 0);
  assert.equal(m.total, 7);
});

T('今日罚金已标记已交 → 不进未交金额', () => {
  const m = F.combine({}, { '2026-11-25': true }, '2026-11-25', F.calc(10, 2, 0), false);
  assert.equal(m.todayOwe, 0);
  assert.equal(m.unpaid, 0);
  assert.equal(m.total, 0);
});

T('非法入参不会抛错也不会白扣钱', () => {
  assert.equal(F.calc('abc', 'x', null).owe, 0);
  assert.equal(F.settledTotal(null, null, true), 0);
  assert.equal(F.combine(null, null, '', null, false).total, 0);
});

console.log('\n=== 契约任务创建后不可修改 ===');

T('普通计划不锁，契约任务一创建就锁', () => {
  assert.equal(F.isContractTask({ id: 'p1', title: '普通' }), false);
  assert.equal(F.isContractTask({ id: 'p2', contract: 'cp-1' }), true);
  assert.equal(F.editLock({ id: 'p1' }, []).locked, false);
  assert.equal(F.editLock({ id: 'p2', contract: 'cp-1' }, [{ id: 'cp-1', endDate: '2026-12-24' }]).locked, true);
});

T('锁定提示带项目到期日，到期后依然不可改', () => {
  const r = F.editLock({ id: 'p2', contract: 'cp-1' }, [{ id: 'cp-1', endDate: '2026-12-24', expired: true }]);
  assert.ok(r.reason.includes('不可修改'));
  assert.ok(r.reason.includes('2026-12-24'));
});

T('抹掉 contract 字段也绕不过：判断只看账本里的原计划', () => {
  const original = { id: 'p2', contract: 'cp-1', title: '健身' };
  const incoming = { id: 'p2', contract: null, title: '改成摸鱼' }; // 攻击载荷
  assert.equal(F.isContractTask(incoming), false);                  // 新 payload 看着像普通计划
  assert.equal(F.editLock(original, [{ id: 'cp-1' }]).locked, true); // 但账本里的原计划仍锁住
});

T('无项目记录时也能锁（项目被删/数据异常不产生空窗）', () => {
  const r = F.editLock({ id: 'p2', contract: 'cp-gone' }, null);
  assert.equal(r.locked, true);
  assert.ok(r.reason.includes('不可修改'));
});

const total = 17;
console.log('\n结果：' + pass + '/' + total + ' 项通过' + (pass === total ? ' ✅' : ' ❌'));
if (pass !== total) process.exitCode = 1;
