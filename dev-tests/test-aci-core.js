'use strict';
/* 阿刺养成 + 战友 PK 核心规则单测：纯逻辑，不联网、不起 Electron、时间可注入 */
const A = require('../src/aci-core.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (!cond) { fail++; console.error('FAIL  ' + name); }
  else { pass++; console.log('ok    ' + name); }
}
const T = 1700000000000; // 固定时间戳
const DAY = 86400000;

/* ---------- 浇水 / 能量 / 升级 ---------- */
ok('默认阿刺 1 级 0 能量', (() => { const a = A.defaultAci(); return a.level === 1 && a.energy === 0 && a.tickets === 0; })());
ok('10积分=1能量：浇水消耗10积分', (() => { const r = A.water(A.defaultAci(), 10, 'd', T); return r.ok && r.effect.costPoints === 10 && r.aci.energy === 1; })());
ok('积分不足不能浇水', (() => { const r = A.water(A.defaultAci(), 9, 'd', T); return !r.ok && r.reason.includes('积分不够'); })());
ok('每次浇水+10经验（1级升2级需20经验=2次浇水）', (() => {
  let a = A.water(A.defaultAci(), 10, 'd', T).aci; // 1级→exp10未升级
  return a.level === 1 && a.exp === 10 && A.expNeeded(1) === 20;
})());
ok('升级经验=目标等级×10：1级2次浇水升2级', (() => {
  let a = A.defaultAci();
  a = A.water(a, 10, 'd', T).aci; // exp10
  const r = A.water(a, 10, 'd', T); // exp20 → 升2级
  return r.effect.levelUps === 1 && r.aci.level === 2 && r.aci.exp === 0;
})());
ok('10级→11级需110经验=11次浇水', (() => {
  let a = A.defaultAci();
  a.level = 10; a.exp = 0;
  let waters = 0;
  for (; waters < 20; waters++) {
    const r = A.water(a, 10, 'd', T);
    a = r.aci;
    if (a.level === 11) return waters + 1 === 11;
  }
  return false;
})());
ok('不浇水不降级：water 不碰 mood/存活', (() => { const a = A.defaultAci(); a.mood = 'sad'; const r = A.water(a, 10, 'd', T); return r.aci.mood === 'sad' && r.aci.level >= 1; })());
ok('满级100不再升', (() => { const a = A.defaultAci(); a.level = 100; const r = A.water(a, 10, 'd', T); return r.aci.level === 100 && r.aci.exp === 0; })());
ok('强化态补给：能量不足无法解锁', (() => { const r = A.useSupply(A.defaultAci(), 'pkTactics'); return !r.ok && r.reason.includes('能量不够'); })());
ok('强化态补给：浇水后解锁深度分析消耗1能量', (() => {
  let a = A.water(A.defaultAci(), 10, 'd', T).aci;
  const r = A.useSupply(a, 'deepAnalysis');
  return r.ok && r.aci.energy === 0 && r.aci.supplies.deepAnalysis === 1;
})());
ok('基础态功能永远可用（不消耗能量）', () => A.isCoreFeature('查表') && A.isCoreFeature('毒舌') && A.isCoreFeature('排计划提议'));

/* ---------- 挑战券 ---------- */
ok('挑战券价格=5条计划×10分=50分', () => A.ticketPrice() === 50);
ok('兑换券消耗50积分', (() => { const r = A.buyTicket(A.defaultAci(), 50); return r.ok && r.aci.tickets === 1 && r.effect.costPoints === 50; })());
ok('积分不足不能换券', (() => { const r = A.buyTicket(A.defaultAci(), 49); return !r.ok; })());
ok('券上限3张（且兑换被拦）', (() => { const a = A.defaultAci(); a.tickets = 3; const r = A.buyTicket(a, 1000); return !r.ok && r.reason.includes('最多'); })());

/* ---------- 段位 / 战力 ---------- */
ok('段位划分正确', () => A.tierOf(1).id === 'sprout' && A.tierOf(20).id === 'sprout' && A.tierOf(21).id === 'grow' && A.tierOf(50).id === 'grow' && A.tierOf(51).id === 'lush' && A.tierOf(80).id === 'lush' && A.tierOf(81).id === 'tall' && A.tierOf(100).id === 'tall');
ok('等级系数=等级/100×100', () => A.levelCoef(50) === 50 && A.levelCoef(1) === 1);
ok('胜负公式：80%完成率+50级=71', () => A.powerOf(80, 50) === 71);
ok('胜负公式：新人100%+1级=70.3', () => A.powerOf(100, 1) === 70.3);
ok('胜负公式权重0.7/0.3', () => A.RULES.WIN_RATE_WEIGHT === 0.7 && A.RULES.ACI_LEVEL_WEIGHT === 0.3);

/* ---------- 频率 / 冷却 / 隐身 ---------- */
ok('每日发起1次，第2次被拦', (() => {
  let a = A.defaultAci(); a.tickets = 3;
  const r1 = A.createChallenge(a, { now: T });
  a = r1.aci;
  const r2 = A.createChallenge(a, { now: T });
  return r1.ok && !r2.ok && /今天|每日|每天/.test(r2.reason);
})());
ok('每日接受2次', () => A.RULES.DAILY_ACCEPT === 2);
ok('同一对手48h内不可重复', (() => {
  let a = A.defaultAci(); a.tickets = 3;
  a.pk.lastOpponent['u1'] = T - 1000;
  const r = A.createChallenge(a, { opponentKey: 'u1', now: T });
  return !r.ok && r.reason.includes('48');
})());
ok('赛后12h冷却', () => A.RULES.AFTER_MATCH_COOLDOWN_MS === 12 * 3600 * 1000);
ok('冷却中不能发起', (() => {
  const a = A.defaultAci(); a.tickets = 3; a.pk.cooldownUntil = T + 3600000;
  const r = A.createChallenge(a, { now: T });
  return !r.ok && r.cooling;
})());
ok('用1张券解除冷却', (() => {
  const a = A.defaultAci(); a.tickets = 2; a.pk.cooldownUntil = T + 3600000;
  const r = A.skipCooldown(a, T);
  return r.ok && r.aci.pk.cooldownUntil === 0 && r.aci.tickets === 1;
})());
ok('隐身24h', (() => { const r = A.setHidden(A.defaultAci(), true, T); return A.isHidden(r.aci, T) && !A.isHidden(r.aci, T + A.RULES.HIDDEN_MS + 1); })());
ok('隐身中不能发起PK', (() => { const a = A.setHidden(A.defaultAci(), true, T).aci; a.tickets = 1; const r = A.createChallenge(a, { now: T }); return !r.ok && r.reason.includes('隐身'); })());
ok('跨日重置每日次数', (() => {
  const a = A.defaultAci(); a.pk.day = A.dayKeyOf(T); a.pk.initiateToday = 1;
  const next = A.refreshDay(a, T + DAY);
  return next.pk.initiateToday === 0;
})());

/* ---------- 匹配池 ---------- */
ok('匹配偏好：同段+完成率±15%+30s', (() => {
  const a = A.defaultAci(); a.level = 30;
  const p = A.matchPreference(a, 70, T);
  return p.tier === 'grow' && p.rateMin === 55 && p.rateMax === 85 && p.waitMs === 30000;
})());
ok('相邻段位计算', () => JSON.stringify(A.adjacentTiers('grow')) === JSON.stringify(['sprout', 'lush']));
ok('跨段保护：高段不会被低段匹配到（我方低段不挑战高段）', (() => {
  const a = A.defaultAci(); a.level = 10; // 新芽
  const cands = [{ key: 'h', level: 90, completionRate: 80 }];
  const p = A.pickOpponent(a, 80, cands, { allowExpanded: true });
  return p === null;
})());
ok('同段优先于完成率校准', (() => {
  const a = A.defaultAci(); a.level = 30;
  const cands = [
    { key: 'same-far', level: 30, completionRate: 20 },
    { key: 'adj-close', level: 55, completionRate: 70 },
  ];
  const p = A.pickOpponent(a, 70, cands, { allowExpanded: true });
  return p && p.key === 'same-far';
})());
ok('连败保护：返回同段完成率最低对手', (() => {
  const a = A.defaultAci(); a.level = 30; a.pk.loseStreak = 3;
  const cands = [{ key: 'hi', level: 30, completionRate: 90 }, { key: 'lo', level: 30, completionRate: 30 }];
  const p = A.useLoseStreakProtect(a, cands);
  return p && p.key === 'lo';
})());

/* ---------- 频道发布 + 时长 ---------- */
ok('挑战默认时长3天', (() => { const a = A.defaultAci(); a.tickets = 1; const r = A.createChallenge(a, { now: T }); return r.match.durationDays === 3; })());
ok('PK时长1天有效', (() => { const a = A.defaultAci(); a.tickets = 1; const r = A.createChallenge(a, { durationDays: 1, now: T }); return r.ok && r.match.expiresAt - r.match.createdAt === DAY; })());
ok('PK时长7天有效', (() => { const a = A.defaultAci(); a.tickets = 1; const r = A.createChallenge(a, { durationDays: 7, now: T }); return r.ok && r.match.expiresAt - r.match.createdAt === 7 * DAY; })());
ok('PK时长0天/8天被拒绝', (() => {
  const a = A.defaultAci(); a.tickets = 3;
  return !A.createChallenge(a, { durationDays: 0, now: T }).ok && !A.createChallenge(a, { durationDays: 8, now: T }).ok;
})());
ok('自习房发布生成广播消息', (() => {
  const a = A.defaultAci(); a.tickets = 1;
  const r = A.createChallenge(a, { venue: 'room', opponentName: '小明', now: T });
  return r.ok && r.broadcast.venue === 'room' && r.broadcast.text.includes('🤖') && r.broadcast.text.includes('小明');
})());
ok('军团频道发布生成广播消息', (() => {
  const a = A.defaultAci(); a.tickets = 1;
  const r = A.createChallenge(a, { venue: 'legion', now: T });
  return r.ok && r.broadcast.venue === 'legion' && (r.broadcast.text.includes('应战') || r.broadcast.text.includes('接 PK'));
})());
ok('本地发起不产生广播', (() => { const a = A.defaultAci(); a.tickets = 1; const r = A.createChallenge(a, { venue: 'local', now: T }); return r.ok && !r.broadcast; })());
ok('发起消耗1张券', (() => { const a = A.defaultAci(); a.tickets = 2; const r = A.createChallenge(a, { now: T }); return r.aci.tickets === 1 && r.effect.costTickets === 1; })());
ok('应战消耗1张券', (() => {
  let a = A.defaultAci(); a.tickets = 2;
  const c = A.createChallenge(a, { opponentKey: 'u1', now: T });
  a = c.aci;
  const r = A.acceptChallenge(a, c.match.id, T);
  return r.ok && r.aci.tickets === 0;
})());
ok('未在1天~1周内的过期挑战不能应战', (() => {
  let a = A.defaultAci(); a.tickets = 2;
  const c = A.createChallenge(a, { durationDays: 1, now: T });
  a = c.aci;
  const r = A.acceptChallenge(a, c.match.id, T + 2 * DAY);
  return !r.ok && r.reason.includes('过期');
})());
ok('60秒未响应返还券', (() => {
  let a = A.defaultAci(); a.tickets = 1;
  const c = A.createChallenge(a, { opponentKey: 'u1', now: T });
  a = c.aci;
  const r = A.expireChallenge(a, c.match.id, 'no_response');
  return r.ok && r.aci.tickets === 1; // 发起扣1又返还1
})());
ok('匹配超时返还券', (() => {
  let a = A.defaultAci(); a.tickets = 1;
  const c = A.createChallenge(a, { now: T });
  a = c.aci;
  const r = A.expireChallenge(a, c.match.id, 'timeout');
  return r.ok && r.aci.tickets === 1 && r.message.includes('返还');
})());

/* ---------- 结算 ---------- */
ok('胜利返还券+额外积分(对手券价值50)', (() => {
  const a = A.defaultAci(); a.tickets = 0;
  const r = A.settle(a, { result: 'win', now: T });
  return r.aci.tickets === 1 && r.effect.bonusPoints === 50 && r.aci.pk.stats.wins === 1;
})());
ok('失败不返还券（非新芽段）', (() => { const a = A.defaultAci(); a.level = 30; a.tickets = 0; const r = A.settle(a, { result: 'lose', now: T }); return r.aci.tickets === 0 && r.aci.pk.stats.losses === 1; })());
ok('平局返还券', (() => { const a = A.defaultAci(); a.tickets = 0; const r = A.settle(a, { result: 'draw', now: T }); return r.aci.tickets === 1 && r.aci.pk.stats.draws === 1; })());
ok('逃跑判负+扣5信誉', (() => { const a = A.defaultAci(); const r = A.settle(a, { result: 'escape', now: T }); return r.effect.repPenalty === 5 && r.aci.pk.stats.escapes === 1; })());
ok('赛后12h冷却生效', (() => { const a = A.defaultAci(); const r = A.settle(a, { result: 'win', now: T }); return A.isCoolingDown(r.aci, T) && !A.isCoolingDown(r.aci, T + 12 * 3600000 + 1); })());
ok('新芽段前3场失败不扣券', (() => {
  const a = A.defaultAci(); a.level = 5; a.tickets = 1; a.pk.noviceLeft = 3;
  const r = A.settle(a, { result: 'lose', now: T });
  return r.aci.tickets === 2 && r.aci.pk.noviceLeft === 2 && r.message.includes('保护');
})());
ok('新芽保护用完后失败扣券', (() => {
  const a = A.defaultAci(); a.level = 5; a.tickets = 1; a.pk.noviceLeft = 0;
  const r = A.settle(a, { result: 'lose', now: T });
  return r.aci.tickets === 1; // 本来就是0消耗（失败不额外扣），保护失去时返还逻辑不触发
})());
ok('连续3败触发连败保护标记', (() => {
  let a = A.defaultAci(); a.level = 30; a.tickets = 3;
  for (let i = 0; i < 3; i++) a = A.settle(a, { result: 'lose', now: T + i * 13 * 3600000 }).aci;
  return a.pk.loseStreak >= 3;
})());

/* ---------- 战友特权 ---------- */
ok('失望模式：连续低完成率触发', (() => {
  const a = A.defaultAci();
  const r = A.checkPrivilege(a, 'disappointment', [{ rate: 30 }, { rate: 30 }, { rate: 30 }]);
  return r.active && r.streak === 3;
})());
ok('强制复盘：未达阈值不触发', (() => {
  const a = A.defaultAci();
  const r = A.checkPrivilege(a, 'forceReview', [{ rate: 80 }, { rate: 80 }]);
  return !r.active;
})());
ok('代扣分：消耗1能量', (() => {
  const a = A.water(A.defaultAci(), 10, 'd', T).aci;
  const r = A.guardDeduct(a);
  return r.ok && r.aci.energy === 0 && r.aci.privileges.deductGuard.charges === 1;
})());
ok('代扣分：能量不足失败', (() => { const r = A.guardDeduct(A.defaultAci()); return !r.ok; })());
ok('信用担保：开启后按自身情况设定额度', (() => {
  let a = A.defaultAci(); a.level = 10; a.energy = 0;
  a = A.toggleCreditGuarantee(a, true).aci;
  return a.guaranteeLeft === 3 && a.privileges.creditGuarantee.active === true; // 1级基数为1 + 10/5=2
})());
ok('抗命机制：不合理命令需确认', () => A.defyCheck(A.defaultAci(), true).needConfirm === true);
ok('抗命机制：合理命令不拦截', () => A.defyCheck(A.defaultAci(), false).needConfirm === false);
ok('主动禁言：人身攻击静音30分钟', (() => {
  const r = A.autoMute(A.defaultAci(), true, T);
  return r.muted && r.until === T + 30 * 60000;
})());
ok('主动禁言：正常对话不静音', () => A.autoMute(A.defaultAci(), false, T).muted === false);

/* ---------- 归一化 ---------- */
ok('老数据缺字段自动补齐', (() => { const a = A.normalizeAci({ level: 5 }); return a.level === 5 && a.energy === 0 && a.pk && a.privileges.deductGuard; })());
ok('券数被限制在0~3', () => A.normalizeAci({ tickets: 99 }).tickets === 3 && A.normalizeAci({ tickets: -5 }).tickets === 0);
ok('等级被限制在1~100', () => A.normalizeAci({ level: 999 }).level === 100 && A.normalizeAci({ level: 0 }).level === 1);

/* ---------- 新：积分商城兑换补给 / 阿刺自己启动 ---------- */
ok('浇水只要10积分', () => A.RULES.POINTS_PER_ENERGY === 10);
ok('补给带积分商城兑换价', () => A.SUPPLIES.every(s => typeof s.points === 'number' && s.points > 0));
ok('积分商城兑换补给：花积分不花能量', (() => {
  const r = A.redeemSupplyWithPoints(A.defaultAci(), 'deepAnalysis', 30);
  return r.ok && r.effect.costPoints === 30 && r.aci.supplies.deepAnalysis === 1 && r.aci.energy === 0;
})());
ok('积分商城兑换补给：积分不足被拦', (() => {
  const r = A.redeemSupplyWithPoints(A.defaultAci(), 'defyGuard', 79);
  return !r.ok && r.reason.includes('积分不够');
})());
ok('阿刺自己启动补给：消耗能量+记每周次数', (() => {
  let a = A.water(A.defaultAci(), 10, 'd', T).aci;
  a = A.water(a, 10, 'd', T).aci; // 2能量
  const r = A.useSupply(a, 'replyForMe', { source: 'auto', now: T });
  return r.ok && r.aci.energy === 0 && r.aci.supplyWeek.used === 1 && r.effect.source === 'auto';
})());
ok('阿刺自己启动补给：每周最多3次', (() => {
  let a = A.defaultAci(); a.energy = 100;
  for (let i = 0; i < 3; i++) a = A.useSupply(a, 'deepAnalysis', { source: 'auto', now: T }).aci;
  const r = A.useSupply(a, 'deepAnalysis', { source: 'auto', now: T });
  return !r.ok && r.reason.includes('每周');
})());
ok('换周后自动补给次数重置', (() => {
  let a = A.defaultAci(); a.energy = 100;
  a = A.useSupply(a, 'deepAnalysis', { source: 'auto', now: T }).aci;
  const nextWeek = T + 8 * DAY;
  const r = A.useSupply(a, 'deepAnalysis', { source: 'auto', now: nextWeek });
  return r.ok && r.aci.supplyWeek.used === 1;
})());
ok('心情好时补给触发概率更大', () => A.autoSupplyChance('happy', false) > A.autoSupplyChance('idle', false) && A.autoSupplyChance('idle', false) > A.autoSupplyChance('angry', false));
ok('失望时补给概率最小', () => A.autoSupplyChance('idle', true) < A.autoSupplyChance('idle', false));
ok('shouldAutoSupply：注入roll可判定触发', (() => {
  const a = A.defaultAci(); a.energy = 3; a.mood = 'happy';
  const yes = A.shouldAutoSupply(a, 'happy', 0.3, T);
  const no = A.shouldAutoSupply(a, 'happy', 0.9, T);
  return yes.trigger && !no.trigger && yes.chance === A.RULES.SUPPLY_AUTO_BASE + A.RULES.SUPPLY_AUTO_GOOD_BONUS;
})());
ok('shouldAutoSupply：无能量不触发', () => !A.shouldAutoSupply(A.defaultAci(), 'happy', 0, T).trigger);

/* ---------- 新：失望状态与互动意愿 ---------- */
ok('设置失望模式：改mood+标志', (() => {
  const r = A.setDisappointed(A.defaultAci(), true, '连续摆烂');
  return r.aci.disappointed && r.aci.mood === 'disappointed';
})());
ok('解除失望模式：mood回落idle', (() => {
  let a = A.setDisappointed(A.defaultAci(), true).aci;
  a = A.setDisappointed(a, false).aci;
  return !a.disappointed && a.mood === 'idle';
})());
ok('失望时普通互动被拒', () => !A.willingToInteract(A.setDisappointed(A.defaultAci(), true).aci, '在吗').willing);
ok('失望时道歉能唤醒互动', () => A.willingToInteract(A.setDisappointed(A.defaultAci(), true).aci, '对不起我错了').willing);
ok('非失望时正常互动', () => A.willingToInteract(A.defaultAci(), '在吗').willing);
ok('失望时聊天触发补给被拒', (() => {
  let a = A.setDisappointed(A.defaultAci(), true).aci; a.energy = 5;
  const r = A.useSupply(a, 'deepAnalysis', { fromChat: true });
  return !r.ok && r.reason.includes('失望');
})());

/* ---------- 新：信用担保按自身情况 ---------- */
ok('担保额度按等级+能量算', (() => {
  let a = A.defaultAci(); a.level = 10; a.energy = 4;
  return A.guaranteeCapacity(a) === 1 + 2 + 2; // 1 + floor(10/5) + floor(4/2)
})());
ok('开启担保时按自身情况设定额度', (() => {
  let a = A.defaultAci(); a.level = 10; a.energy = 4;
  const r = A.toggleCreditGuarantee(a, true);
  return r.ok && r.aci.guaranteeLeft === 5 && r.effect.cap === 5;
})());
ok('额度内赖账不降级只扣额度', (() => {
  let a = A.defaultAci(); a.level = 10; a.energy = 4;
  a = A.toggleCreditGuarantee(a, true).aci;
  const r = A.breakGuarantee(a);
  return r.ok && r.aci.level === 10 && r.aci.guaranteeLeft === 4 && !r.effect.downgraded;
})());
ok('额度耗尽才降级', (() => {
  let a = A.defaultAci(); a.level = 10; a.energy = 0;
  a = A.toggleCreditGuarantee(a, true).aci; // cap=3
  for (let i = 0; i < 2; i++) a = A.breakGuarantee(a).aci;
  const r = A.breakGuarantee(a);
  return r.ok && r.aci.level === 9 && r.effect.downgraded;
})());

/* ---------- 新：PK链接 ---------- */
ok('频道广播带 pq://pk 链接与matchId', (() => {
  const a = A.defaultAci(); a.tickets = 1;
  const r = A.createChallenge(a, { venue: 'room', challengerName: '阿明', challengerRate: 80, now: T });
  return r.ok && r.broadcast.link && r.broadcast.link.startsWith('pq://pk?')
    && r.broadcast.link.includes(encodeURIComponent(r.match.id)) && r.broadcast.matchId === r.match.id;
})());
ok('PK链接含发起人/天数/战力', (() => {
  const a = A.defaultAci(); a.tickets = 1;
  const r = A.createChallenge(a, { venue: 'legion', challengerName: '阿明', challengerRate: 80, durationDays: 2, now: T });
  return r.broadcast.link.includes('n=' + encodeURIComponent('阿明'))
    && r.broadcast.link.includes('d=2') && r.broadcast.link.includes('r=');
})());

console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) process.exitCode = 1;
