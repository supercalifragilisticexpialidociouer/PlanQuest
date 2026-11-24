'use strict';
/* 皮肤系统单测：五种带刺生物的 头像参数 / 主题色 / 语气 / 改名判定 / 换皮肤拒绝 / 重置代价
 * 纯逻辑，不联网、不起 Electron；所有随机都注入固定 rng，结果可复现。 */
const S = require('../src/aci-skin.js');
const A = require('../src/aci-core.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (!cond) { fail++; console.error('FAIL  ' + name); }
  else { pass++; console.log('ok    ' + name); }
}
const T = 1700000000000;
const rng0 = () => 0;      // 永远取第一个候选 / 判定必过
const rng9 = () => 0.999;  // 永远取最后一个候选 / 判定必挂

/* ---------- 皮肤表 ---------- */
ok('皮肤共 5 种', S.SKINS.length === 5);
ok('皮肤 id 唯一且包含需求里的五种', (() => {
  const ids = S.SKINS.map((s) => s.id);
  return new Set(ids).size === 5 &&
    ['cactus', 'rose', 'hedgehog', 'chestnut', 'porcupine'].every((x) => ids.includes(x));
})());
ok('每种皮肤都有头像参数/主题色/语气/建议名', S.SKINS.every((s) =>
  s.emoji && s.tagline && s.theme && s.theme.accent && s.look && s.voice && Array.isArray(s.names) && s.names.length >= 3));
ok('未知皮肤返回 null（不能静默当成仙人掌）', S.get('dragon') === null);
ok('ensure 未知皮肤兜底仙人掌', S.ensure('dragon').id === 'cactus');

/* ---------- 主题色 ---------- */
ok('主题色 = 皮肤主色', S.themeVars('rose', false)['--pqb-teal'] === '#e0507e');
ok('浅色/深色底透明度不同', (() => {
  const l = S.themeVars('rose', false)['--pqb-chip'];
  const d = S.themeVars('rose', true)['--pqb-chip'];
  return l !== d && /rgba\(/.test(l) && /rgba\(/.test(d);
})());
ok('豪猪主题色更冷更深（和玫瑰明显不同）', S.themeVars('porcupine')['--pqb-teal'] !== S.themeVars('rose')['--pqb-teal']);

/* ---------- 语气微调 ---------- */
ok('没选皮肤：原样返回，不做风格化', S.decorate('别摸鱼了，加油。', '', { rng: rng0 }) === '别摸鱼了，加油。');
ok('仙人掌：保持原味', S.decorate('别摸鱼了，加油。', 'cactus', { rng: rng0 }) === '别摸鱼了，加油。');
ok('玫瑰：摸鱼→偷闲 + 带花 emoji', (() => {
  const t = S.decorate('别摸鱼了，加油。', 'rose', { rng: rng9 });
  return t.includes('偷闲') && /🌹|🥀/.test(t);
})());
ok('玫瑰：偶尔加"亲爱的"前缀', S.decorate('今天还有三条没做完。', 'rose', { rng: rng0 }).startsWith('亲爱的，'));
ok('豪猪：软话换成硬话（加油→别磨蹭，建议你→你最好）', (() => {
  const t = S.decorate('建议你加油，稍微动一下。', 'porcupine', { rng: rng9 });
  return t.includes('你最好') && t.includes('别磨蹭') && !t.includes('加油');
})());
ok('豪猪：不出现花 emoji', !/🌹|🌸|🥀|🌺/.test(S.decorate('加油。', 'porcupine', { rng: rng0 })));
ok('豪猪：长回复砍到前两句', (() => {
  const t = S.decorate('第一句。第二句。第三句。第四句。', 'porcupine', { rng: rng9 });
  return t.includes('第一句') && t.includes('第二句') && !t.includes('第三句');
})());
ok('豪猪：rng 命中时补一句硬尾巴', /少废话|别磨叽|就这|照做/.test(S.decorate('去做。', 'porcupine', { rng: rng0 })));
ok('刺猬：偶尔漏一点软', (() => {
  const t = S.decorate('计划还没动。', 'hedgehog', { rng: rng0 });
  return /没扎你|收了收|说话直/.test(t);
})());
ok('板栗：说实在话 + 记账', (() => {
  const t = S.decorate('今天三条没完成。', 'chestnut', { rng: rng0 });
  return t.includes('实在话') && t.includes('账我给你记着');
})());
ok('模型回答（正事）不改写不截断，只可能加署名花', (() => {
  const src = '第一步：打开设置。第二步：填写目标。第三步：保存。第四步：查看进度。';
  const t = S.decorate(src, 'porcupine', { kind: 'model', rng: rng0 });
  return t === src;
})());
ok('模型回答给玫瑰加花但不改字', (() => {
  const src = '第一步：打开设置。第二步：保存。';
  const t = S.decorate(src, 'rose', { kind: 'model', rng: rng0 });
  return t.startsWith(src) && /🌹|🥀/.test(t);
})());

/* ---------- 改名判定 ---------- */
ok('空名字：硬拒绝', (() => { const r = S.evaluateRename('cactus', '  ', { current: '阿刺', rng: rng0 }); return !r.accept && r.hard; })());
ok('同名：拒绝，别逗我玩', (() => { const r = S.evaluateRename('cactus', '阿刺', { current: '阿刺', rng: rng0 }); return !r.accept && /逗我玩/.test(r.reply); })());
ok('超过 8 个字：拒绝', !S.evaluateRename('cactus', '一二三四五六七八九', { current: '阿刺', rng: rng0 }).accept);
ok('带符号/空格：拒绝', !S.evaluateRename('cactus', 'a b', { current: '阿刺', rng: rng0 }).accept);
ok('脏名字：拒绝', (() => { const r = S.evaluateRename('cactus', '傻逼', { current: '阿刺', rng: rng0 }); return !r.accept && r.hard; })());
ok('改回「阿刺」：无条件通过', (() => {
  const r = S.evaluateRename('rose', '阿刺', { current: '小玫', rng: rng9 });
  return r.accept && r.chance === 1;
})());
ok('建议名单里的名字更容易被接受（通过率更高）', (() => {
  const a = S.evaluateRename('rose', '小玫', { current: '阿刺', mood: 'idle', rng: rng0 });
  const b = S.evaluateRename('rose', '钢铁侠', { current: '阿刺', mood: 'idle', rng: rng0 });
  return a.chance > b.chance;
})());
ok('心情好 > 心情差（通过率）', (() => {
  const happy = S.evaluateRename('cactus', '刺头', { current: '阿刺', mood: 'happy', rng: rng0 }).chance;
  const angry = S.evaluateRename('cactus', '刺头', { current: '阿刺', mood: 'angry', rng: rng0 }).chance;
  const dis = S.evaluateRename('cactus', '刺头', { current: '阿刺', mood: 'disappointed', disappointed: true, rng: rng0 }).chance;
  return happy > angry && angry >= dis - 0.01 && dis < happy;
})());
ok('改得越多越难再改', (() => {
  const a = S.evaluateRename('cactus', '刺头', { current: '阿刺', renameCount: 0, rng: rng0 }).chance;
  const b = S.evaluateRename('cactus', '刺头', { current: '阿刺', renameCount: 3, rng: rng0 }).chance;
  return b < a;
})());
ok('通过率永远在 5%~95% 之间（不会必过/必挂）', S.SKINS.every((s) => {
  const hi = S.evaluateRename(s.id, '测试名', { mood: 'happy', level: 100, rng: () => 0 }).chance;
  const lo = S.evaluateRename(s.id, '测试名', { mood: 'angry', disappointed: true, renameCount: 3, rng: () => 0 }).chance;
  return hi <= 0.95 && lo >= 0.05;
}));
ok('拒绝理由带上了皮肤性格（仙人掌提刺，玫瑰提花）', (() => {
  const c = S.evaluateRename('cactus', '小可爱', { current: '阿刺', mood: 'angry', rng: rng9 });
  const r = S.evaluateRename('rose', '小可爱', { current: '阿刺', mood: 'angry', rng: rng9 });
  return !c.accept && !r.accept && /刺|软/.test(c.reply) && /花|俗|亲爱的/.test(r.reply);
})());
ok('接受时的回复会叫出新名字', (() => {
  const r = S.evaluateRename('cactus', '刺头', { current: '阿刺', mood: 'happy', rng: rng0 });
  return r.accept && r.reply.includes('刺头');
})());

/* ---------- 换皮肤：一律拒绝 ---------- */
ok('五种皮肤都拒绝换皮肤，并给出合同话术', S.SKINS.every((s) => {
  const r = S.requestSkinChange(s.id, { rng: rng0 });
  return r.ok === false && r.refused === true && typeof r.reply === 'string' && r.reply.length > 4;
}));
ok('仙人掌/豪猪明确说出「合同签了就别想反悔」', ['cactus', 'porcupine'].every((id) => {
  const r = S.requestSkinChange(id, { rng: rng0 });
  return r.reply.includes('合同签了就别想反悔');
}));
ok('拒绝时顺手指出唯一出路（重置）', /重置/.test(S.requestSkinChange('rose', { rng: rng0 }).hint));

/* ---------- 重置代价 ---------- */
ok('重置代价写明三条硬成本 + 保留项', (() => {
  const c = S.resetCost();
  return c.items.length === 3 && c.confirmWord === '重新开始' && /计划/.test(c.keep);
})());
ok('五种皮肤都有离开台词', S.SKINS.every((s) => typeof S.resetLine(s.id, rng0) === 'string' && S.resetLine(s.id).length > 4));

/* ---------- 与 aci-core 打通 ---------- */
ok('默认阿刺未选皮肤 = 锁定', (() => {
  const a = A.defaultAci();
  return A.isIdentityLocked(a) && a.identity.name === '阿刺' && a.identity.skin === '';
})());
ok('选皮肤成功，并写入 chosenAt', (() => {
  const r = A.chooseSkin(A.defaultAci(), 'rose', T);
  return r.ok && r.aci.identity.skin === 'rose' && r.aci.identity.chosenAt === T && r.message.includes('玫瑰');
})());
ok('已选皮肤后再选：拒绝 + 合同话术', (() => {
  let a = A.chooseSkin(A.defaultAci(), 'rose', T).aci;
  const r = A.chooseSkin(a, 'cactus', T + 1);
  return !r.ok && r.refused && /反悔/.test(r.reason) && r.aci.identity.skin === 'rose';
})());
ok('不存在的皮肤：拒绝且不改状态', (() => {
  const r = A.chooseSkin(A.defaultAci(), 'dragon', T);
  return !r.ok && r.aci.identity.skin === '';
})());
ok('归一化把非法皮肤洗成未选，名字兜底阿刺', (() => {
  const a = A.normalizeAci({ identity: { skin: 'dragon', name: '   ' } });
  return a.identity.skin === '' && a.identity.name === '阿刺';
})());
ok('归一化保留合法身份', (() => {
  const a = A.normalizeAci({ identity: { skin: 'hedgehog', name: '团子', renameCount: 2 } });
  return a.identity.skin === 'hedgehog' && a.identity.name === '团子' && a.identity.renameCount === 2;
})());
ok('改名成功：名字写入 + renameCount 递增', (() => {
  let a = A.chooseSkin(A.defaultAci(), 'chestnut', T).aci;
  const r = A.setCompanionName(a, '栗子', T + 1);
  return r.ok && r.aci.identity.name === '栗子' && r.aci.identity.renameCount === 1;
})());
ok('改名超长被截到 8 字', (() => {
  const r = A.setCompanionName(A.defaultAci(), '一二三四五六七八九十', T);
  return r.aci.identity.name.length === 8;
})());
ok('空名字不能落地', !A.setCompanionName(A.defaultAci(), '   ', T).ok);
ok('改名判定会读阿刺当前心情与等级', (() => {
  let a = A.chooseSkin(A.defaultAci(), 'cactus', T).aci;
  a = { ...a, mood: 'angry', level: 50 };
  const ev = A.evaluateCompanionName(a, '刺头', rng0);
  return ev.chance < 0.95 && ev.chance > 0.05;
})());
ok('重置：回到未选皮肤 + 标记清聊天记录', (() => {
  let a = A.chooseSkin(A.defaultAci(), 'porcupine', T).aci;
  a = A.setCompanionName(a, '老豪', T).aci;
  a.level = 30; a.exp = 50; a.energy = 4;
  const r = A.resetCompanion(a, rng0);
  return r.ok && r.purgeChat === true && A.isIdentityLocked(r.aci) &&
    r.aci.level === 1 && r.aci.energy === 0 && r.aci.identity.name === '阿刺';
})());
ok('重置后原有 aci 对象不被就地改写（纯函数）', (() => {
  let a = A.chooseSkin(A.defaultAci(), 'rose', T).aci;
  A.resetCompanion(a);
  return a.identity.skin === 'rose';
})());

console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
