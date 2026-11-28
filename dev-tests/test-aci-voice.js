'use strict';
/* 文案基调回归：表情负责「娇」，文案负责「傲」。
 * 抽取 buddy.js 里的表情指令 / 加油 / 警告台词，断言它们是「居高临下赏你恩赐」，
 * 而不是平等拌嘴 / 苦口婆心 / 调情。纯文本扫描，不起 Electron。 */
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
function ok(name, cond) { if (!cond) { fail++; console.error('FAIL  ' + name); } else { pass++; console.log('ok    ' + name); } }

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'buddy.js'), 'utf-8');
const skin = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'aci-skin.js'), 'utf-8');

/* 只统计 say: [...] 里的中文台词，不把 k:'wiggle'、mood:'smirk' 之类的键名算进分母 */
const funBlock = src.slice(src.indexOf('var FUN_RULES = ['), src.indexOf('function funIntent'));
const cheersBlock = src.slice(src.indexOf('var CHEERS = ['), src.indexOf('];', src.indexOf('var CHEERS = [')));
const scoldsBlock = src.slice(src.indexOf('var SCOLDS = {'), src.indexOf('var scoldLast'));

function sayLines(block) {
  const out = [];
  const re = /say:\s*\[([\s\S]*?)\]/g;
  var mm;
  while ((mm = re.exec(block))) {
    (mm[1].match(/'[^']*[\u4e00-\u9fa5][^']*'/g) || []).forEach(function (x) { out.push(x); });
  }
  return out;
}
function plainLines(block) {
  return (block.match(/'[^']*[\u4e00-\u9fa5][^']*'/g) || []);
}

/* 傲气词典：自命不凡 / 赏你恩赐 / 把对方当不配的凡人。命中即算「傲」 */
const PROUD = /本刺|赏|恩赐|福气|祖上|体面|不配|配不上|配看|金贵|掉价|开恩|尊口|金口|凡人|跪安|退下|不伺候|没见过世面|看得起|没那么闲|收藏好|收费|懒得|给面子|面子|点名|挑眉|歪头笑|笑眯眯|掩嘴笑|撑着胳膊|没白活|学不来|清静|演的|嫌吵|谢恩|不外借|好相处|谁都配|金口一开|没那么好养|看得上|没兴趣|嫌掉价|一路绿灯|举双手赞成/;

function ratio(lines) { return lines.filter(function (l) { return PROUD.test(l); }).length / (lines.length || 1); }

const says = sayLines(funBlock);
ok('九个表情/动作指令都有台词，且台词数量充足', says.length >= 24);
ok('表情台词普遍带「傲」而非平等拌嘴', ratio(says) >= 0.9);
ok('加油池含用户点名的标杆意象（自己拔刺替你扎）', /自己拔根刺|拔根刺下来|拔刺/.test(cheersBlock));
ok('加油池不再「苦口婆心」，改为居高临下', ratio(plainLines(cheersBlock)) >= 0.85 && !/坑是从脚下填平的|这条是加油，不是催命/.test(src));
ok('警告毒舌走萌脸补刀（带表情动作）', /笑眯眯|歪头笑|掩嘴笑|挑眉/.test(scoldsBlock));
ok('催办改为「赏你期限」而非「做不完也比零点强」', /赏你 20 分钟|福气/.test(src) && !/做不完也比零点强/.test(src));
ok('输入框傲娇提示仍在（聊天里提改名/换皮肤）', /本刺金贵|答不答应、看心情/.test(src));

/* 皮肤身份话术：拒绝/接受仍走聊天，且保留单测关键词 */
ok('改名拒绝傲气化仍保留「刺/软、花/俗/亲爱的」关键词',
  /这名字太软，配不上我这身刺/.test(skin) && /俗。我这朵花不同意/.test(skin));
ok('换皮肤仍是「合同」话术（shot-skin 断言依赖）', /合同签了就别想反悔/.test(skin));
ok('开场白立住「盯着你是你的福气」的傲气', /是你的福气|不见闲人|慢慢还/.test(skin));

console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) process.exit(1);
