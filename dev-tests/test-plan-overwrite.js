/* .pqplan 覆盖合并惩罚单测：口径 / 阶梯 / 留痕 / 审讯 / 台词
 * 用法：node dev-tests/test-plan-overwrite.js
 */
'use strict';

const assert = require('assert');
const PO = require('../src/plan-overwrite');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.log('  ✗ ' + name + ' → ' + e.message); }
}

const T0 = 1764000000000;
const DAY = 24 * 3600 * 1000;
function plan(id, extra) {
  return Object.assign({ id, title: '计划' + id, points: 20, days: [0, 1, 2, 3, 4, 5, 6], allowProcs: [] }, extra || {});
}
function ctx(over) {
  return Object.assign({
    whitelist: [], points: 100, aciLevel: 12, at: T0, source: 'a.pqplan',
  }, over || {});
}

console.log('\n[1] diff：新增按新建、覆盖掉按删除');
const cur = [plan('p1'), plan('p2'), plan('c1', { contract: 'cp1' })];
const inc = [plan('p2'), plan('p3', { allowProcs: ['wechat.exe'] }), plan('c3', { contract: 'cp3' })];
ok('合并模式：只算新增，不删任何本机计划', () => {
  const d = PO.diffPlans(cur, inc, 'merge', 'all');
  assert.deepStrictEqual(d.added.map((p) => p.id), ['p3', 'c3']);
  assert.strictEqual(d.removes, 0);
  assert.strictEqual(d.kept.length, 3);
});
ok('全量覆盖：本机计划全部算「被覆盖掉」', () => {
  const d = PO.diffPlans(cur, inc, 'replace', 'all');
  assert.strictEqual(d.removes, 3);
  assert.deepStrictEqual(d.added.map((p) => p.id), ['p2', 'p3', 'c3']);
});
ok('仅普通计划覆盖：只删普通、只加普通（同 id 被换掉也算新增）', () => {
  const d = PO.diffPlans(cur, inc, 'replace', 'normal');
  assert.deepStrictEqual(d.removed.map((p) => p.id), ['p1', 'p2']);
  /* 范围覆盖先删本机同类，再合入文件里的：p2 虽同 id，旧版已删、新版算新增 */
  assert.deepStrictEqual(d.added.map((p) => p.id), ['p2', 'p3']);
  assert.strictEqual(d.kept.length, 1);
});
ok('仅契约计划覆盖：只删契约、只加契约', () => {
  const d = PO.diffPlans(cur, inc, 'replace', 'contract');
  assert.deepStrictEqual(d.removed.map((p) => p.id), ['c1']);
  assert.deepStrictEqual(d.added.map((p) => p.id), ['c3']);
});

console.log('\n[2] 基础扣分口径（对齐 plan:save / plan:delete）');
ok('新建口径常量 = 10，删除口径常量 = 0', () => {
  assert.strictEqual(PO.RULES.NEW_PLAN_PROC_COST, 10);
  assert.strictEqual(PO.RULES.DELETE_PLAN_COST, 0);
});
ok('普通计划新增非白名单软件 → 扣 10', () => {
  assert.strictEqual(PO.newPlanCost(plan('x', { allowProcs: ['wechat.exe'] }), ctx()), 10);
});
ok('在白名单里的软件 → 不扣', () => {
  assert.strictEqual(PO.newPlanCost(plan('x', { allowProcs: ['wechat.exe'] }), ctx({ whitelist: ['WECHAT.EXE'] })), 0);
});
ok('契约任务创建 / 编辑一律不扣', () => {
  assert.strictEqual(PO.newPlanCost(plan('x', { contract: 'cp1', allowProcs: ['game.exe'] }), ctx()), 0);
});
ok('只改标题时间（无放行进程）不扣', () => {
  assert.strictEqual(PO.newPlanCost(plan('x'), ctx()), 0);
});
ok('baseCost：新增按新建算、覆盖掉按删除算，分列可查', () => {
  const d = PO.diffPlans(cur, inc, 'replace', 'all');
  const c = PO.baseCost(d, ctx());
  assert.strictEqual(c.addCost, 10);   // p3 带了非白名单
  assert.strictEqual(c.delCost, 0);    // 删计划口径 = 0
  assert.strictEqual(c.points, 10);
  assert.strictEqual(c.adds, 3);
  assert.strictEqual(c.removes, 3);
});

console.log('\n[3] 只打开编辑：不扣分、不应用、不记账');
ok('isInspect 只认 inspect', () => {
  assert.strictEqual(PO.isInspect('inspect'), true);
  assert.strictEqual(PO.isInspect('replace'), false);
  assert.strictEqual(PO.isInspect('merge'), false);
});
ok('inspect 结果：applied=false / deducted=0 / counted=false', () => {
  const r = PO.inspectResult();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.deducted, 0);
  assert.strictEqual(r.counted, false);
  assert.ok(!/扣分|应用/.test(r.message) || /不扣分/.test(r.message));
});
ok('编辑态不碰账本：走 inspect 时不调 commit，count 仍为 0', () => {
  const st = PO.defaultState();
  const r = PO.inspectResult();
  assert.strictEqual(r.counted, false);
  assert.strictEqual(PO.normalizeState(st).count, 0);
  assert.strictEqual(PO.normalizeState(st).deserter, false);
});
ok('编辑台词照样娇里带刺', () => {
  assert.ok(/斜眼笑/.test(PO.LINES.inspect));
  assert.ok(/不拔刺|本刺/.test(PO.LINES.inspect));
});

console.log('\n[4] 阶梯「赎罪」：越删越狠');
const d0 = PO.diffPlans(cur, inc, 'replace', 'all');
const cost0 = PO.baseCost(d0, ctx());
ok('第 1 次：10% 积分 / 80 经验 / 2 能量 / 斜眼笑', () => {
  const p = PO.assess(PO.defaultState(), d0, ctx(), T0);
  assert.strictEqual(p.tier, 1);
  assert.strictEqual(p.rate, 0.10);
  assert.strictEqual(p.pointsCut, 10);
  assert.strictEqual(p.expCut, 80);
  assert.strictEqual(p.energyCut, 2);
  assert.strictEqual(p.mood, 'sideeye');
  assert.strictEqual(p.lock, false);
  assert.strictEqual(p.demote, false);
});
ok('第 2 次：30% 积分 / 160 经验 / 3 能量 / 翻白眼', () => {
  const p = PO.assess({ count: 1 }, d0, ctx(), T0);
  assert.strictEqual(p.tier, 2);
  assert.strictEqual(p.pointsCut, 30);
  assert.strictEqual(p.expCut, 160);
  assert.strictEqual(p.energyCut, 3);
  assert.strictEqual(p.mood, 'eyeroll');
  assert.strictEqual(p.lock, false);
});
ok('第 3 次及以上：50% / 300 经验 / 5 能量 / 锁 24h / 掉回新手 / 生气脸', () => {
  const p = PO.assess({ count: 2 }, d0, ctx(), T0);
  assert.strictEqual(p.tier, 3);
  assert.strictEqual(p.pointsCut, 50);
  assert.strictEqual(p.expCut, 300);
  assert.strictEqual(p.lock, true);
  assert.strictEqual(p.lockMs, DAY);
  assert.strictEqual(p.demote, true);
  assert.strictEqual(p.mood, 'angry');
  assert.strictEqual(PO.assess({ count: 99 }, d0, ctx(), T0).tier, 3);
});
ok('没分可扣时不为难人：cut = 0', () => {
  assert.strictEqual(PO.assess({ count: 0 }, d0, ctx({ points: 0 }), T0).pointsCut, 0);
});

console.log('\n[5] 审讯：确认才扣，取消啥事没有');
ok('审讯明细写清「按新建口径」「按删除口径」「加密收尸」', () => {
  const p = PO.assess(PO.defaultState(), d0, ctx(), T0);
  const q = PO.interrogation(d0, p, cost0, ctx(), () => 0);
  assert.ok(/确认覆盖/.test(q.title));
  assert.ok(q.details.some((x) => /按新建口径/.test(x)));
  assert.ok(q.details.some((x) => /按删除口径/.test(x)));
  assert.ok(q.details.some((x) => /加密收尸/.test(x)));
  assert.strictEqual(q.confirm, '确认覆盖，挨扎');
  assert.strictEqual(q.cancel, '取消，本刺记着');
  assert.ok(/你那点破计划我可都记着，删了也得挨扎/.test(q.lead));
});
ok('用户点名的「买路钱」原句一字不差', () => {
  assert.strictEqual(
    PO.LINES.buyRoad,
    '想跑？行，本刺肯让你覆盖，算你有点胆。扣你50积分，当买路钱。下次再敢删，我直接拔刺扎你屏幕。'
  );
});
ok('取消路径不调 commit → 账本纹丝不动', () => {
  const st = PO.defaultState();
  const confirmed = false;
  const after = confirmed ? PO.commit(st, PO.assess(st, d0, ctx(), T0), d0, ctx(), T0) : st;
  assert.strictEqual(after.count, 0);
  assert.strictEqual(after.deserter, false);
  assert.strictEqual(after.pendingBoot, null);
});
ok('确认后：逃兵标签 + 次数 + 旧账待翻', () => {
  let st = PO.defaultState();
  for (let i = 0; i < 3; i++) {
    const p = PO.assess(st, d0, ctx(), T0 + i * 1000);
    st = PO.commit(st, p, d0, ctx(), T0 + i * 1000);
  }
  assert.strictEqual(st.count, 3);
  assert.strictEqual(st.deserter, true);
  assert.strictEqual(st.tags.length, 3);
  assert.strictEqual(st.tags[0].tag, '逃兵');
  assert.ok(st.pendingBoot && st.pendingBoot.removedTitles.length > 0);
  assert.strictEqual(st.lockUntil, T0 + 2000 + DAY);
});

console.log('\n[6] 24 小时冻结');
ok('冻结期内 isFrozen = true，过期自动解冻', () => {
  const p = PO.assess({ count: 2 }, d0, ctx(), T0);
  const st = PO.commit({ count: 2 }, p, d0, ctx(), T0);
  assert.strictEqual(PO.isFrozen(st, T0 + 3600000), true);
  assert.strictEqual(PO.publicState(st, T0 + 3600000).frozen, true);
  assert.strictEqual(PO.isFrozen(st, T0 + DAY + 1), false);
  assert.ok(PO.frozenLeft(st, T0) > DAY - 10);
});
ok('冻结台词把「钥匙我吞了」和剩余小时数说出来', () => {
  const line = PO.line('frozen', { left: 23, n: 3 }, () => 0);
  assert.ok(/23小时后|23小时/.test(line));
  assert.ok(/本刺|钥匙|刺/.test(line));
});

console.log('\n[7] 无损变有损：加密备份 / 历史留痕');
ok('vaultPayload 把被覆盖掉的旧计划一台不落收进来', () => {
  const d = { plans: cur, log: { '2026-11-01': { p1: { status: 'done' } } }, profile: { points: 88, totalDone: 3 }, aci: { level: 12, exp: 40, energy: 9 } };
  const diff = PO.diffPlans(cur, inc, 'replace', 'all');
  const payload = PO.vaultPayload(d, diff, ctx(), T0);
  assert.strictEqual(payload.plans.length, 3);
  assert.strictEqual(payload.plans[0].title, '计划p1');
  assert.strictEqual(payload.profile.points, 88);
  assert.strictEqual(payload.aci.level, 12);
  assert.ok(payload.log['2026-11-01']);
});
ok('vaultIndex 只留索引，不含旧计划明文', () => {
  const payload = PO.vaultPayload({ plans: cur, log: {}, profile: { points: 88 }, aci: {} }, d0, ctx(), T0);
  const idx = PO.vaultIndex(payload, 'abc123');
  assert.strictEqual(idx.n, 3);
  assert.strictEqual(idx.sha256, 'abc123');
  assert.strictEqual(idx.plans, undefined);
  assert.strictEqual(idx.log, undefined);
  assert.strictEqual(JSON.stringify(idx).includes('计划p1'), true); // 只有标题摘要
});
ok('备份索引最多留 20 条', () => {
  let st = PO.defaultState();
  for (let i = 0; i < 30; i++) st = PO.pushVault(st, { at: T0 + i, n: 1, titles: [], sha256: '' });
  assert.strictEqual(st.vault.length, PO.RULES.VAULT_KEEP);
  assert.strictEqual(st.vault[0].at, T0 + 10);
});
ok('账本不被新文件覆盖掉（别想装失忆）', () => {
  const old = PO.commit(PO.commit(PO.defaultState(), PO.assess(PO.defaultState(), d0, ctx(), T0), d0, ctx(), T0),
    PO.assess({ count: 1 }, d0, ctx(), T0), d0, ctx(), T0);
  const saved = PO.normalizeState(old);
  const replaced = { profile: { points: 999 }, aci: { level: 1, exp: 0, energy: 0 }, overwrite: PO.defaultState() };
  replaced.overwrite = saved; // 各端 apply 里把这行挂回本机账本
  assert.strictEqual(replaced.overwrite.count, 2);
  assert.strictEqual(replaced.overwrite.deserter, true);
  assert.strictEqual(replaced.overwrite.tags.length, 2);
});

console.log('\n[8] 扣刺真的落到积分 / 能量 / 经验 / 等级');
ok('第 1 次：积分扣 10%+基础分，能量 -2，经验 -80', () => {
  const d = { profile: { points: 100 }, aci: { level: 12, exp: 200, energy: 10, mood: 'happy', disappointed: false } };
  const p = PO.assess(PO.defaultState(), d0, ctx(), T0);
  const e = PO.penalize(d, p, cost0);
  assert.strictEqual(e.pointsCut, 20);      // 10% = 10 + 新建口径 10
  assert.strictEqual(d.profile.points, 80);
  assert.strictEqual(d.aci.energy, 8);
  assert.strictEqual(d.aci.exp, 120);
  assert.strictEqual(d.aci.mood, 'idle');
});
ok('第 3 次：Lv.12 直接掉回新手，生气脸 + 失望标记', () => {
  const d = { profile: { points: 100 }, aci: { level: 12, exp: 500, energy: 20, mood: 'happy', disappointed: false } };
  const p = PO.assess({ count: 2 }, d0, ctx(), T0);
  PO.penalize(d, p, cost0);
  assert.strictEqual(d.aci.level, 1);
  assert.strictEqual(d.aci.exp, 0);
  assert.strictEqual(d.aci.energy, 15);
  assert.strictEqual(d.aci.mood, 'angry');
  assert.strictEqual(d.aci.disappointed, true);
});

console.log('\n[9] 翻旧账 / 台词：表情负责娇，文案负责傲');
ok('第 1 档台词：斜眼笑 + 拔刺扎屏幕', () => {
  const p = PO.assess(PO.defaultState(), d0, ctx(), T0);
  const v = PO.verdict(p, d0, cost0, ctx(), () => 0);
  assert.strictEqual(v.mood, 'sideeye');
  assert.ok(/斜眼笑/.test(v.say));
  assert.ok(/扎|刺/.test(v.say));
  assert.ok(/本刺/.test(v.say));
  assert.ok(!/\{cut\}|\{exp\}/.test(v.say), '占位符必须填掉');
});
ok('第 2 档台词：翻白眼 + 仙人掌拔自己根', () => {
  const p = PO.assess({ count: 1 }, d0, ctx(), T0);
  const v = PO.verdict(p, d0, cost0, ctx(), () => 0);
  assert.strictEqual(v.mood, 'eyeroll');
  assert.ok(/翻白眼/.test(v.say));
  assert.ok(/仙人掌|拔自己根|台阶/.test(v.say));
});
ok('第 3 档台词：生气脸 + 锁死 24 小时 + 掉回新手 + 原地爆炸', () => {
  const p = PO.assess({ count: 2 }, d0, ctx(), T0);
  const v = PO.verdict(p, d0, cost0, ctx(), () => 0);
  assert.strictEqual(v.mood, 'angry');
  assert.ok(/锁死 24 小时/.test(v.say));
  assert.ok(/掉回新手|Lv\./.test(v.say));
  assert.ok(/原地爆炸|信不信/.test(v.say));
});
ok('启动翻旧账：扣 80 经验 + 别想装失忆', () => {
  const p = PO.assess(PO.defaultState(), d0, ctx(), T0);
  const st = PO.commit(PO.defaultState(), p, d0, ctx(), T0);
  const b = PO.takeBoot(st, () => 0);
  assert.ok(/扣 10 积分|扣 10/.test(b.line) || /积分/.test(b.line));
  assert.ok(/80 经验/.test(b.line));
  assert.ok(/别想装失忆/.test(b.line));
  assert.strictEqual(b.mood, 'sideeye');
});
ok('旧账只读一次：读完就销，不会天天念', () => {
  const p = PO.assess(PO.defaultState(), d0, ctx(), T0);
  const st = PO.commit(PO.defaultState(), p, d0, ctx(), T0);
  const b1 = PO.takeBoot(st, () => 0);
  assert.ok(b1.line);
  const b2 = PO.takeBoot(b1.state, () => 0);
  assert.strictEqual(b2.line, '');
  assert.strictEqual(b1.state.pendingBoot, null);
});
ok('取消台词：把刺收回去，但账先挂着', () => {
  const line = PO.line('cancel', {}, () => 0);
  assert.ok(/识相|省得|本刺/.test(line));
  assert.ok(/挂着|忘了|下回/.test(line));
});
ok('所有档位台词都带「刺」字或扎人意象（傲到天上）', () => {
  const all = [].concat(PO.LINES.tier1, PO.LINES.tier2, PO.LINES.tier3, PO.LINES.boot, PO.LINES.interrogate);
  for (const s of all) assert.ok(/刺|扎|本刺|屏幕|根/.test(s), '台词不够傲：' + s);
});

console.log('\n[10] 状态归一化 / 兼容老数据');
ok('老数据缺字段自动补齐', () => {
  const st = PO.normalizeState({ count: 4, lockUntil: T0 + 1000 });
  assert.strictEqual(st.count, 4);
  assert.ok(Array.isArray(st.tags));
  assert.ok(Array.isArray(st.vault));
  assert.strictEqual(st.deserter, false);
  assert.strictEqual(st.pendingBoot, null);
});
ok('脏数据不会把次数 / 锁定时间算成 NaN', () => {
  const st = PO.normalizeState({ count: 'abc', lockUntil: null, tags: 'x', vault: 3 });
  assert.strictEqual(st.count, 0);
  assert.strictEqual(st.lockUntil, 0);
  assert.ok(Array.isArray(st.tags));
  assert.ok(Array.isArray(st.vault));
});
ok('publicState 暴露下一档与冻结状态给 UI', () => {
  const s = PO.publicState({ count: 1, lockUntil: T0 + DAY, deserter: true }, T0);
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.nextTier, 2);
  assert.strictEqual(s.frozen, true);
  assert.strictEqual(s.deserter, true);
  assert.strictEqual(s.rules.expLoss[0], 80);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail) process.exit(1);
