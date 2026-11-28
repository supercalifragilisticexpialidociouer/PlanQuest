/* 第二版：分皮肤个性化心情 / 顶罪 / AI 人设 / 本地遥测 单测
 * 用法：node dev-tests/test-skin-mood.js
 */
'use strict';
const assert = require('assert');
const PK = require('../src/aci-perk');
const SK = require('../src/aci-skin');
const LLM = require('../src/renderer/ala-llm');
const ACT = require('../src/renderer/ala-act');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.log('  ✗ ' + name + ' → ' + e.message); }
}
const T0 = 1764000000000;
const rng = (v) => () => v;
function sin(over) { return PK.normalizeSin(Object.assign({}, PK.defaultSin(), over || {})); }

console.log('\n[1] 五皮肤独立心情初值 / 等级 / 标签');
const IDS = ['cactus', 'rose', 'hedgehog', 'chestnut', 'porcupine'];
ok('五皮肤初值正确 55/45/40/50/35', () => {
  assert.strictEqual(PK.skinMoodInit('cactus'), 55);
  assert.strictEqual(PK.skinMoodInit('rose'), 45);
  assert.strictEqual(PK.skinMoodInit('hedgehog'), 40);
  assert.strictEqual(PK.skinMoodInit('chestnut'), 50);
  assert.strictEqual(PK.skinMoodInit('porcupine'), 35);
});
ok('等级划分按皮肤命名，互不相同', () => {
  const levels = IDS.map((id) => PK.skinMoodLevel(id, PK.skinMoodInit(id)));
  assert.strictEqual(new Set(levels).size, 5, levels.join('/'));
  assert.strictEqual(PK.skinMoodLevel('cactus', 85), '高效');
  assert.strictEqual(PK.skinMoodLevel('cactus', 50), '平稳');
  assert.strictEqual(PK.skinMoodLevel('cactus', 10), '低效');
  assert.strictEqual(PK.skinMoodLevel('rose', 95), '舒坦');
  assert.strictEqual(PK.skinMoodLevel('rose', 25), '扎手');
});
ok('defaultSin / normalizeSin 自动补齐分皮肤账本', () => {
  const d = PK.defaultSin();
  assert.strictEqual(d.skinMood.cactus, 55);
  assert.strictEqual(d.skinMood.porcupine, 35);
  const legacy = PK.normalizeSin({ skinMood: { cactus: 999 }, familiarity: 500 });
  assert.strictEqual(legacy.skinMood.cactus, 100, '上钳');
  assert.strictEqual(legacy.familiarity, 100);
});

console.log('\n[2] 分皮肤心情升降（各皮肤事件表不同）');
ok('仙人掌：全勤 +4 / 删档 −12 / 顶嘴 −4', () => {
  let s = sin();
  let r = PK.applySkinMood(s, 'cactus', 'completedAll', {}, T0);
  assert.strictEqual(r.delta, 4);
  assert.strictEqual(r.mood, 59);
  r = PK.applySkinMood(r.sin, 'cactus', 'overwrotePlanFile', {}, T0);
  assert.strictEqual(r.delta, -12);
  r = PK.applySkinMood(r.sin, 'cactus', 'arguedBack', {}, T0);
  assert.strictEqual(r.delta, -4);
});
ok('玫瑰：夸奖 +6 / 批评 −12 且记小本本（历史分下降）', () => {
  let r = PK.applySkinMood(sin(), 'rose', 'praisedACI', {}, T0);
  assert.strictEqual(r.delta, 6);
  assert.strictEqual(r.sin.historicalScore, 1);
  r = PK.applySkinMood(r.sin, 'rose', 'criticizedACI', {}, T0);
  assert.strictEqual(r.delta, -12);
  assert.strictEqual(r.sin.historicalScore, -1);
  r = PK.applySkinMood(r.sin, 'rose', 'praisedACI', {}, T0);
  const r2 = PK.applySkinMood(r.sin, 'rose', 'praisedACI', {}, T0);
  assert.strictEqual(r2.delta, 0, '每日夸奖只记一次');
});
ok('刺猬：每日互动升亲密度，熟了 +1 / 陌生期 −3', () => {
  let s = sin();
  for (let i = 0; i < 3; i++) s = PK.applySkinMood(s, 'hedgehog', 'interactedDaily', {}, T0).sin;
  assert.strictEqual(s.familiarity, 9);
  s = PK.applySkinMood(s, 'hedgehog', 'streak14', {}, T0).sin;
  assert.strictEqual(s.familiarity, 19);
  // 陌生期（<20）扣心情
  let r = PK.applySkinMood(s, 'hedgehog', 'missedPlan', {}, T0);
  assert.strictEqual(r.delta, -4 - 3, '漏计划 −4 叠加陌生期 −3');
});
ok('板栗：还债 +10 且债务 −1 / 赖账 −20 且债务 +1', () => {
  let s = sin({ debtDays: 2 });
  let r = PK.applySkinMood(s, 'chestnut', 'repaidDebt', {}, T0);
  assert.strictEqual(r.delta, 10);
  assert.strictEqual(r.sin.debtDays, 1);
  r = PK.applySkinMood(r.sin, 'chestnut', 'defaultedDebt', {}, T0);
  assert.strictEqual(r.delta, -20);
  assert.strictEqual(r.sin.debtDays, 2);
});
ok('豪猪：证明自己 +8 / 任何失误 −6 / 一天不登录 −8', () => {
  let r = PK.applySkinMood(sin(), 'porcupine', 'provedWorth', {}, T0);
  assert.strictEqual(r.delta, 8);
  r = PK.applySkinMood(r.sin, 'porcupine', 'missedAnyPlan', {}, T0);
  assert.strictEqual(r.delta, -6);
  r = PK.applySkinMood(r.sin, 'porcupine', 'inactiveDays', { days: 2 }, T0);
  assert.strictEqual(r.delta, -16);
});
ok('凌晨自然恢复：各皮肤低于阈值才补，同日幂等', () => {
  const s = sin({ skinMood: { cactus: 50, rose: 40, hedgehog: 35, chestnut: 45, porcupine: 30 } });
  const d = PK.skinDailyRecover(s, T0);
  const m = d.sin.skinMood;
  assert.strictEqual(m.cactus, 53, '仙人掌 +3');
  assert.strictEqual(m.rose, 42, '玫瑰 +2');
  assert.strictEqual(m.porcupine, 31, '豪猪 +1');
  assert.strictEqual(PK.skinDailyRecover(d.sin, T0).applied.length, 0, '同日幂等');
});

console.log('\n[3] 分皮肤顶罪判定（顺序与硬约束不变）');
function coverCtx(over) { return Object.assign({ at: T0, pointsCut: 50, energy: 100, skin: 'cactus' }, over || {}); }
ok('仙人掌：base 22%，R=21.9 顶 / 22.1 不顶', () => {
  // 心情 55 → 修正 +0.03（>=60 不成立，>=35 为 0）→ 概率 0.22
  const s = sin();
  const a = PK.decideSkinCover(s, coverCtx(), rng(0.219));
  const b = PK.decideSkinCover(s, coverCtx(), rng(0.221));
  assert.strictEqual(a.covered, true, 'prob=' + a.prob + ' roll=' + a.roll);
  assert.strictEqual(b.covered, false);
});
ok('各皮肤冷却 / 日限不同，逐皮肤生效', () => {
  const cfg = PK.SKIN_MOOD;
  assert.strictEqual(cfg.cactus.cover.cooldownH, 7);
  assert.strictEqual(cfg.rose.cover.cooldownH, 8);
  assert.strictEqual(cfg.hedgehog.cover.cooldownH, 6);
  assert.strictEqual(cfg.chestnut.cover.cooldownH, 5);
  assert.strictEqual(cfg.porcupine.cover.cooldownH, 10);
  // 豪猪周限 2
  const hp = PK.decideSkinCover(sin({ week: PK.weekKey(T0), weekUsed: 2 }), coverCtx({ skin: 'porcupine' }), rng(0));
  assert.strictEqual(hp.reason, 'quota');
});
ok('刺猬亲密度抬高基础概率；板栗命中带债务', () => {
  const fam = sin({ familiarity: 80, skinMood: { hedgehog: 80 } });
  const d = PK.decideSkinCover(fam, coverCtx({ skin: 'hedgehog' }), rng(0.3));
  assert.strictEqual(d.covered, true, 'base 0.32 + mod 0.10 = 0.42');
  const ch = PK.decideSkinCover(sin(), coverCtx({ skin: 'chestnut' }), rng(0));
  assert.strictEqual(ch.debtDays, 3);
  const committed = PK.commitSkinCover(sin(), ch, T0);
  assert.strictEqual(committed.debtDays, 3);
});
ok('硬约束：ctx.force/request 一律忽略；无导出开关', () => {
  const d = PK.decideSkinCover(sin(), coverCtx({ force: true, request: true, cover: true }), rng(0.99));
  assert.strictEqual(d.covered, false);
  ['forceCover', 'requestCover', 'setProbability', 'setCoverEnabled'].forEach((k) => assert.ok(!(k in PK), k));
});

console.log('\n[4] 本地遥测与平衡报表');
ok('记录判定 → 报表给各皮肤有效命中率（不摆概率承诺）', () => {
  let s = sin();
  const d1 = PK.decideSkinCover(s, coverCtx(), rng(0.1));
  s = PK.recordCover(s, d1, T0);
  const d2 = PK.decideSkinCover(s, coverCtx(), rng(0.9));
  s = PK.recordCover(s, d2, T0 + 1000);
  const rpt = PK.balanceReport(s);
  assert.strictEqual(rpt.total, 2);
  const row = rpt.skins.find((x) => x.skin === 'cactus');
  assert.ok(row);
  assert.strictEqual(row.eligible, 2);
  assert.strictEqual(row.covered, 1);
  assert.strictEqual(row.hitRate, 50);
  assert.ok(!('prob' in row) || row.avgProb !== undefined, '报表是给开发者的统计，非承诺');
});

console.log('\n[5] AI 提示词按皮肤 + 心境，含蓄新手暗示');
ok('personaText 含外形/性情/心境，不含概率数值', () => {
  const t = PK.personaText('cactus', '高效');
  assert.ok(t.includes('仙人掌') && t.includes('毒舌') && t.includes('高效'));
  assert.ok(!/[0-9]+%/.test(t), '不泄露概率');
  assert.ok(!t.includes('冷却') && !t.includes('概率'));
});
ok('buildMessages 注入 persona 后 system 变化，老调用不变', () => {
  const oldMsgs = LLM.buildMessages('你好', 'x');
  const newMsgs = LLM.buildMessages('你好', 'x', [], PK.personaText('rose', '舒坦'));
  assert.ok(newMsgs[0].content.includes('玫瑰（带刺的花）'));
  assert.ok(!oldMsgs[0].content.includes('玫瑰（带刺的花）'), '老调用不注入具体皮肤人设');
  const actOld = ACT.buildMessages('plan', '排计划', 'x');
  const actNew = ACT.buildMessages('plan', '排计划', 'x', [], PK.personaText('porcupine', '冷淡'));
  assert.ok(actNew[0].content.includes('豪猪（生人勿近）'));
  assert.ok(!actOld[0].content.includes('豪猪（生人勿近）'));
});
ok('开场白与引导含含蓄暗示、不点破机制', () => {
  const g = SK.greeting('hedgehog', '阿刺');
  assert.ok(g.includes('交情是慢慢攒的'));
  const h = SK.onboardHint();
  assert.ok(h.includes('脾气就什么样') && h.includes('自己琢磨'));
  assert.ok(!/概率|冷却|%/.test(g + h), '不摊牌参数');
});

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
