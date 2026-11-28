/* 阿刺「五套皮肤利弊 + 数值心情 + 顶罪」核心单测
 * 用法：node dev-tests/test-aci-perk.js
 */
'use strict';

const assert = require('assert');
const PK = require('../src/aci-perk');
const ACI = require('../src/aci-core');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.log('  ✗ ' + name + ' → ' + e.message); }
}

const T0 = 1764000000000;
const DAY = 24 * 3600 * 1000;
const rng = (v) => () => v;
function sin(over) { return PK.normalizeSin(Object.assign({}, PK.defaultSin(), over || {})); }
function coverCtx(over) {
  return Object.assign({ at: T0, pointsCut: 50, energy: 100 }, over || {});
}

console.log('\n[1] 五套皮肤：利弊、毒舌、倍率');
const IDS = ['cactus', 'hedgehog', 'rose', 'chestnut', 'porcupine'];
ok('五套皮肤齐全且各有 利/弊/毒舌', () => {
  IDS.forEach((id) => {
    const s = PK.prosCons(id);
    assert.strictEqual(PK.getSkill(id).id, id);
    assert.ok(s.pros.length >= 2 && s.cons.length >= 2, id + ' 利弊条数');
    assert.ok(s.taunt && s.taunt.length > 10, id + ' 毒舌');
  });
});
ok('毒舌原句全部按用户口径落地', () => {
  assert.ok(PK.taunt('cactus').includes('你那点毅力够我扎几次的'));
  assert.ok(PK.taunt('hedgehog').includes('看着萌，扎你的时候可别哭'));
  assert.ok(PK.taunt('rose').includes('我动手可不轻'));
  assert.ok(PK.taunt('chestnut').includes('我直接枯给你看'));
  assert.ok(PK.taunt('porcupine').includes('特效费积分'));
});
ok('原皮：经验 +10% / 耗水翻倍 / 覆盖扣分翻倍', () => {
  const m = PK.modsFor('cactus');
  assert.strictEqual(m.expMul, 1.1);
  assert.strictEqual(m.waterCostMul, 2);
  assert.strictEqual(m.overwritePointsMul, 2);
  assert.strictEqual(m.navSpeed > 1, true);
});
ok('萌球：初始好感 12 / 拖延减免 20% / 经验 −15% / 竞技场 −20%', () => {
  const m = PK.modsFor('hedgehog');
  assert.strictEqual(m.initialFavor, 12);
  assert.strictEqual(m.delayShield, 0.2);
  assert.strictEqual(m.expMul, 0.85);
  assert.strictEqual(m.arenaMul, 0.8);
});
ok('怒刺红：竞技场 +20% / 覆盖扣分 +50% / 三天摆烂锁', () => {
  const m = PK.modsFor('rose');
  assert.strictEqual(m.arenaMul, 1.2);
  assert.strictEqual(m.overwritePointsMul, 1.5);
  assert.strictEqual(m.slumpLockDays, 3);
});
ok('枯木：经验 −30% / 满级后能量上限 +30% / 覆盖直接降级', () => {
  const low = PK.modsFor('chestnut', { aciLevel: 12 });
  const full = PK.modsFor('chestnut', { aciLevel: 100 });
  assert.strictEqual(low.expMul, 0.7);
  assert.strictEqual(low.energyCapMul, 1, '没满级不给 +30%');
  assert.strictEqual(full.energyCapMul, 1.3);
  assert.strictEqual(full.energyCap, 130);
  assert.strictEqual(PK.shapePlan({ pointsCut: 50 }, 'chestnut', { aciLevel: 12 }).plan.demoteTarget, 11);
});
ok('幻影蓝：偶尔双倍经验 / 特效维护费 5 分 / 带路偏差', () => {
  const m = PK.modsFor('porcupine');
  assert.strictEqual(m.doubleExpChance, 0.12);
  assert.strictEqual(m.skinUpkeep, 5);
  assert.ok(m.navBias > 0);
});
ok('shapePlan：扣分倍率 / 减免 / 能量消耗都按皮肤走', () => {
  const base = { pointsCut: 100, expCut: 80, energyCut: 10 };
  assert.strictEqual(PK.shapePlan(base, 'cactus').plan.pointsCut, 200);
  assert.strictEqual(PK.shapePlan(base, 'hedgehog').plan.pointsCut, 80);
  assert.strictEqual(PK.shapePlan(base, 'rose').plan.pointsCut, 150);
  assert.strictEqual(PK.shapePlan(base, 'cactus').plan.energyCut, 20);
  assert.strictEqual(PK.shapePlan(base, 'cactus').plan.pointsCutRaw, 100);
});
ok('aci-core：选萌球播种初始好感 12，浇水按皮肤倍率', () => {
  const a = ACI.defaultAci();
  const c = ACI.chooseSkin(a, 'hedgehog', T0);
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.aci.favor, 12);
  const w0 = ACI.water(a, 1000, '2025-11-24', T0, PK.modsFor(''));
  const w1 = ACI.water(a, 1000, '2025-11-24', T0, PK.modsFor('cactus'));
  assert.strictEqual(w0.effect.costPoints, 10);
  assert.strictEqual(w1.effect.costPoints, 20, '原皮耗水翻倍');
  assert.strictEqual(w1.effect.expGain, 11, '原皮经验 +10%');
  const w2 = ACI.water(a, 1000, '2025-11-24', T0, PK.modsFor('porcupine'));
  assert.strictEqual(w2.effect.costPoints, 15, '幻影蓝含 5 分特效维护费');
});

console.log('\n[2] 分皮肤说话风格');
ok('五套风格互不相同且幂等', () => {
  const lines = IDS.map((id) => PK.styleLine('你又拖了。', id));
  assert.strictEqual(new Set(lines).size, 5);
  IDS.forEach((id) => {
    const once = PK.styleLine('你又拖了。', id);
    assert.strictEqual(PK.styleLine(once, id), once, id + ' 幂等');
  });
});
ok('萌球砍掉动作描写；幻影蓝带「恩赐」；raw / 长文本不调味', () => {
  assert.ok(!PK.styleLine('（笑眯眯）你又拖了～', 'hedgehog').includes('笑眯眯'));
  assert.ok(PK.styleLine('你又拖了。', 'porcupine').includes('恩赐'));
  assert.strictEqual(PK.styleLine('（笑眯眯）你又拖了。', 'cactus', 'raw'), '（笑眯眯）你又拖了。');
  const long = '本刺'.repeat(200);
  assert.strictEqual(PK.styleLine(long, 'rose'), long);
});
ok('语气壳不改数字与事实', () => {
  const s = PK.styleLine('扣你 50 积分。', 'rose');
  assert.ok(s.includes('50 积分'));
});

console.log('\n[3] 数值心情：升降 / 恢复 / 事件表');
ok('默认心情 3，三档换算正好 70% / 40% / 10%', () => {
  assert.strictEqual(PK.defaultSin().mood, 3);
  assert.strictEqual(PK.coverProb(9), 0.7);
  assert.strictEqual(PK.coverProb(3), 0.4);
  assert.strictEqual(PK.coverProb(-3), 0.1);
  assert.strictEqual(PK.coverProb(99), 0.7, '上钳');
  assert.strictEqual(PK.coverProb(-99), 0.1, '下钳');
  assert.strictEqual(PK.moodBandOf(9), 'good');
  assert.strictEqual(PK.moodBandOf(3), 'normal');
  assert.strictEqual(PK.moodBandOf(-3), 'bad');
});
ok('心情上升：打卡 +1，连续 3/7/14/30 天额外加成且每档只给一次', () => {
  /* 从 −9 起步，避免连加撞到 MAX 10 被钳位影响 delta 断言 */
  let s = sin({ mood: -9 });
  let r = PK.applyMood(s, 'checkin', { streak: 3 }, T0);
  assert.strictEqual(r.delta, 3);
  assert.strictEqual(r.mood, -6);
  assert.ok(r.line.includes('3 天'));
  r = PK.applyMood(r.sin, 'checkin', { streak: 3 }, T0);
  assert.strictEqual(r.delta, 1, '同档不重复给');
  r = PK.applyMood(r.sin, 'checkin', { streak: 7 }, T0);
  assert.strictEqual(r.delta, 4, '7 天档 +1+3');
  r = PK.applyMood(r.sin, 'checkin', { streak: 30 }, T0);
  assert.strictEqual(r.delta, 9, '30 天档 +1+8');
});
ok('互动微量 +0.2 且 10 分钟内节流；挑战 +3', () => {
  let s = sin({ mood: 0 });
  let r = PK.applyMood(s, 'interact', { kind: 'chat' }, T0);
  assert.strictEqual(r.delta, 0.2);
  r = PK.applyMood(r.sin, 'interact', { kind: 'water' }, T0 + 60000);
  assert.strictEqual(r.delta, 0, '节流');
  r = PK.applyMood(r.sin, 'interact', { kind: 'chat' }, T0 + 11 * 60000);
  assert.strictEqual(r.delta, 0.2);
  r = PK.applyMood(r.sin, 'challenge', {}, T0);
  assert.strictEqual(r.delta, 3);
  assert.ok(r.line.includes('+3'));
});
ok('心情下降：两天未登录 −1 / 删覆盖 −2 / 忽略提醒 −1 / 48h 衰减', () => {
  let r = PK.applyMood(sin({ mood: 5 }), 'noLogin', { days: 2 }, T0);
  assert.strictEqual(r.delta, -1);
  assert.strictEqual(PK.applyMood(r.sin, 'noLogin', { days: 2 }, T0).delta, 0, '同一天不重复扣');
  r = PK.applyMood(sin({ mood: 5 }), 'overwrite', {}, T0);
  assert.strictEqual(r.delta, -2);
  assert.ok(r.line.includes('−2'));
  r = PK.applyMood(sin({ mood: 5 }), 'ignoreReminder', {}, T0);
  assert.strictEqual(r.delta, -1);
  assert.strictEqual(PK.applyMood(r.sin, 'ignoreReminder', {}, T0 + 60000).delta, 0, '1h 节流');
  r = PK.applyMood(sin({ mood: 5 }), 'idle', { hours: 72 }, T0);
  assert.strictEqual(r.delta, -1);
  assert.strictEqual(PK.applyMood(r.sin, 'idle', { hours: 72 }, T0).delta, 0, '同一天不重复');
});
ok('心情恢复：凌晨负值 +1 且补到 0 封顶；道歉一次性恢复、一天一次', () => {
  let r = PK.applyMood(sin({ mood: -3 }), 'dailyRecover', {}, T0);
  assert.strictEqual(r.mood, -2);
  r = PK.applyMood(sin({ mood: -0.2 }), 'dailyRecover', {}, T0);
  assert.strictEqual(r.mood, 0, '不会恢复成正心情');
  assert.strictEqual(PK.applyMood(sin({ mood: 2 }), 'dailyRecover', {}, T0).delta, 0, '正值不恢复');
  r = PK.applyMood(sin({ mood: -5 }), 'apology', {}, T0);
  assert.strictEqual(r.delta, 2);
  assert.strictEqual(r.mood, -3);
  r = PK.applyMood(r.sin, 'apology', {}, T0);
  assert.strictEqual(r.delta, 0, '一天只收一次道歉');
  assert.ok(r.line.includes('省省'));
  r = PK.applyMood(sin({ mood: -1 }), 'apology', {}, T0);
  assert.strictEqual(r.mood, 0, '补到 0 封顶');
});
ok('dailySettle 跨天补算；bootSettle 幂等且结算未登录/不互动', () => {
  const s = sin({ mood: -3, lastRecoveryDay: PK.dayKeyOf(T0 - 3 * DAY), lastLoginAt: T0 - 2 * DAY, lastInteractAt: T0 - 3 * DAY });
  const d = PK.dailySettle(s, T0);
  assert.strictEqual(d.sin.mood, 0);
  assert.strictEqual(d.applied.length, 3);
  const b = PK.bootSettle(s, {}, T0);
  assert.ok(b.events.length >= 2, '未登录 + 48h 不互动 + 凌晨恢复');
  assert.ok(b.events.some((x) => x.reason === 'noLogin' || x.event === 'noLogin'));
  const b2 = PK.bootSettle(b.sin, {}, T0);
  assert.strictEqual(b2.events.length, 0, '同一时刻再调不重复扣');
  assert.strictEqual(JSON.stringify(b2.sin), JSON.stringify(b.sin), '同一天再读状态不改动账本（不触发写盘）');
  const b3 = PK.bootSettle(b.sin, {}, T0 + 60000);
  assert.strictEqual(JSON.stringify(b3.sin), JSON.stringify(b.sin), '一分钟内轮询也不刷新 lastLoginAt');
});
ok('心情日志保留每次 delta，normalizeSin 老数据自动补字段', () => {
  const r = PK.applyMood(sin({ mood: 0 }), 'overwrite', {}, T0);
  assert.strictEqual(r.sin.moodLog.length, 1);
  assert.strictEqual(r.sin.moodLog[0].delta, -2);
  const legacy = PK.normalizeSin({ weekUsed: 3, mood: 999 });
  assert.strictEqual(legacy.mood, 10);
  assert.strictEqual(legacy.energy, 100);
  assert.ok(Array.isArray(legacy.streakMilestones));
});

console.log('\n[4] 顶罪最终算法：冷却 → 每日上限 → 周/月 → 能量 → R(0~100)');
ok('基础 25% + 心情修正：R=39.9 顶、R=40.1 不顶', () => {
  const s = sin({ mood: 3 });
  const a = PK.decideCover(s, coverCtx(), rng(0.399));
  const b = PK.decideCover(s, coverCtx(), rng(0.401));
  assert.strictEqual(a.covered, true);
  assert.strictEqual(a.reason, 'covered');
  assert.strictEqual(a.roll, 39.9);
  assert.strictEqual(b.covered, false);
  assert.strictEqual(b.reason, 'mood');
  assert.ok(b.line.length > 0, '不顶也要按心情说话');
});
ok('心情好 70% / 差 10%，心情差顶了补「下不为例」', () => {
  const good = PK.decideCover(sin({ mood: 9 }), coverCtx(), rng(0.69));
  assert.strictEqual(good.covered, true);
  assert.strictEqual(PK.decideCover(sin({ mood: 9 }), coverCtx(), rng(0.71)).covered, false);
  const bad = PK.decideCover(sin({ mood: -3 }), coverCtx(), rng(0.09));
  assert.strictEqual(bad.covered, true);
  assert.ok(bad.line.includes('下不为例'));
  assert.strictEqual(PK.decideCover(sin({ mood: -3 }), coverCtx(), rng(0.11)).covered, false);
});
ok('台词随心情变：好/一般/差三套各不相同', () => {
  const set = [9, 3, -3].map((m) => PK.decideCover(sin({ mood: m }), coverCtx(), rng(0.99)).moodLine);
  assert.strictEqual(new Set(set).size, 3);
});
ok('全局冷却：30 分钟内第二次一律不顶', () => {
  const s = sin({ lastCoverAt: T0 - 10 * 60000 });
  const r = PK.decideCover(s, coverCtx(), rng(0));
  assert.strictEqual(r.reason, 'cooldown');
  assert.ok(r.line.includes('还没缓过来'));
});
ok('每日上限 1 次；周 3 次；月 10 次；优先级从冷却开始', () => {
  const d = PK.dayKeyOf(T0);
  assert.strictEqual(PK.decideCover(sin({ coverDay: d, coverDayUsed: 1 }), coverCtx(), rng(0)).reason, 'daily');
  assert.strictEqual(PK.decideCover(sin({ week: PK.weekKey(T0), weekUsed: 3 }), coverCtx(), rng(0)).reason, 'quota');
  assert.strictEqual(PK.decideCover(sin({ month: PK.monthKey(T0), monthUsed: 10 }), coverCtx(), rng(0)).reason, 'quota');
  const all = sin({ lastCoverAt: T0 - 60000, coverDay: d, coverDayUsed: 1, week: PK.weekKey(T0), weekUsed: 3 });
  assert.strictEqual(PK.decideCover(all, coverCtx(), rng(0)).reason, 'cooldown');
});
ok('能量不足 50 不顶；没有扣分不顶', () => {
  assert.strictEqual(PK.decideCover(sin(), coverCtx({ energy: 49 }), rng(0)).reason, 'energy');
  assert.strictEqual(PK.decideCover(sin(), coverCtx({ pointsCut: 0 }), rng(0)).reason, 'nocut');
});
ok('命中：能量 −50 / 好感 −3 / 重置冷却 / 记周月日次数', () => {
  const s = sin({ mood: 3, energy: 100, favor: 5 });
  const d = PK.decideCover(s, coverCtx(), rng(0));
  assert.strictEqual(d.energyCost, 50);
  assert.strictEqual(d.favorDrop, 3);
  const c = PK.commitCover(s, d, T0);
  assert.strictEqual(c.total, 1);
  assert.strictEqual(c.weekUsed, 1);
  assert.strictEqual(c.monthUsed, 1);
  assert.strictEqual(c.coverDayUsed, 1);
  assert.strictEqual(c.lastCoverAt, T0);
  assert.strictEqual(c.mood, 3, '心情账本完整保留');
  assert.strictEqual(c.history[0].cut, 50);
  assert.strictEqual(PK.decideCover(c, coverCtx({ at: T0 + 60000 }), rng(0)).reason, 'cooldown');
});
ok('用户不能规定他是否顶罪：ctx.force / request / cover 一律忽略', () => {
  const s = sin({ mood: 3 });
  const r = PK.decideCover(s, coverCtx({ force: true, request: true, cover: true, wantCover: true }), rng(0.99));
  assert.strictEqual(r.covered, false);
  ['requestCover', 'forceCover', 'setCoverEnabled', 'setProbability', 'cover'].forEach((k) => {
    assert.ok(!(k in PK), '不应导出 ' + k);
  });
});
ok('publicSin 只给心情与次数，不摆概率、不给开关', () => {
  const p = PK.publicSin(sin({ mood: 9, total: 2 }), T0);
  assert.strictEqual(p.mood, 9);
  assert.strictEqual(p.moodLabel, '心情不错');
  assert.strictEqual(p.total, 2);
  assert.ok(!('prob' in p) && !('probability' in p));
  assert.ok(p.note.includes('自己说了算'));
});

console.log('\n[5] 摆烂锁 / 求顶罪 / 皮肤台词');
ok('怒刺红连续三天摆烂 → 锁 24 小时', () => {
  const s = PK.applySlump(sin(), { missedDays: 3, slumpLockDays: 3 }, T0);
  assert.strictEqual(PK.isSlumpLocked(s, T0 + 3600000), true);
  assert.strictEqual(PK.isSlumpLocked(s, T0 + DAY + 1), false);
  assert.ok(PK.slumpLine('rose').includes('门锁了'));
});
ok('求他顶罪只会被怼，没有「同意」分支', () => {
  for (let i = 0; i < 3; i++) {
    const l = PK.pleaLine(rng(i / 3));
    assert.ok(l.length > 8);
    assert.ok(!/好的|答应|同意/.test(l));
  }
});
ok('超限毒舌两句都够毒', () => {
  assert.ok(PK.quotaLine(rng(0)).includes('擦屁股'));
  assert.ok(PK.quotaLine(rng(0.9)).includes('自己拉的屎自己擦'));
});

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
