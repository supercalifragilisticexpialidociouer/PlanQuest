/* 信誉三档特权 / 军团内排名 / 邀请海报规则 —— 单元测试（node 直接跑） */
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
}

/* ---------------- 1. credit-priv 纯函数 ---------------- */
const P = require('../web/credit-priv.js');

console.log('\n【等级区间】');
ok('70 分没有等级（受限）', P.tierIndex(70) === 0 && P.levelOf(70).key === '');
ok('80 分 → L1 基础', P.tierIndex(80) === 1 && P.levelOf(80).name === '基础');
ok('100 分 → L2 社交', P.levelOf(100).key === 'L2');
ok('120 分 → L3 荣耀', P.levelOf(120).key === 'L3');
ok('160 分仍在 L3', P.levelOf(160).key === 'L3');
ok('负数不越界', P.tierIndex(-999) === 0);
ok('105 分到 L3 还差 15', P.levelOf(105).nextIn === 15);

console.log('\n【借分额度跟等级走】');
ok('受限 30', P.loanLimit(60) === 30);
ok('L1 50', P.loanLimit(90) === 50);
ok('L2 80', P.loanLimit(105) === 80);
ok('L3 120', P.loanLimit(130) === 120);

console.log('\n【特权清单不许吹】');
const p105 = P.privs(105);
const byId = (id) => p105.find((x) => x.id === id);
ok('L1 的三项都解锁', ['flip', 'quota', 'loan'].every((k) => byId(k).unlocked));
ok('L2 建团 / 裁定候选已解锁', byId('legion').unlocked && byId('arbiter').unlocked);
ok('L3 星标未解锁', byId('badge').unlocked === false);
ok('规划中的两项标了 coming', byId('match').coming === true && byId('beta').coming === true);
ok('规划中的功能不算「已解锁」以外还另标 coming', byId('match').unlocked === true && byId('match').coming === true);
ok('生效的特权都写了生效位置', P.privs(130).filter((x) => x.live).every((x) => !!x.where));
ok('分数不可购买：清单里没有「买」字', !P.privs(130).some((x) => /买/.test(x.good + x.name)));

console.log('\n【军团内排名】');
const roster = [
  { uid: 'a', alias: '阿七', credit: 130 },
  { uid: 'b', alias: '老陈', credit: 118 },
  { uid: 'me', alias: '我', credit: 105 },
  { uid: 'c', alias: '小满', credit: 96 },
  { uid: 'd', alias: '阿吉', credit: 88 },
];
const r = P.rank(roster, 'me');
ok('名次 3 / 5', r.pos === 3 && r.total === 5);
ok('高于 50%', r.abovePct === 50);
ok('等级 L2', r.level.key === 'L2');
ok('第一名 abovePct=100', P.rank(roster, 'a').abovePct === 100);
ok('最后一名 abovePct=0', P.rank(roster, 'd').abovePct === 0);
ok('没有 credit 的成员不参与排序', P.rank([...roster, { uid: 'x', alias: '未知', credit: null }], 'me').total === 5);
ok('孤儿 uid 返回 null', P.rank(roster, 'zzz') === null);
ok('空名册返回 null', P.rank([], 'me') === null);
ok('排名结果不含别人的分数', !JSON.stringify(r).includes('130'));
ok('同分按昵称稳定排序', P.rank([{ uid: 'a', alias: 'B', credit: 100 }, { uid: 'b', alias: 'A', credit: 100 }], 'b').pos === 1);

/* ---------------- 2. 海报规则 ---------------- */
console.log('\n【海报：只画过程，不画分数】');
const shareSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'share.js'), 'utf8');
const drawStart = shareSrc.indexOf('function drawPoster(');
const drawEnd = shareSrc.indexOf('/* ============================ 面板与交互');
const drawSrc = shareSrc.slice(drawStart, drawEnd);
const used = [...drawSrc.matchAll(/\bd\.(\w+)/g)].map((m) => m[1]);
const allowed = new Set(['streak', 'helpWeek', 'challengeDone', 'focusMax', 'plans']);
ok('drawPoster 只读五个过程字段', used.every((k) => allowed.has(k)), [...new Set(used)].join(','));
ok('drawPoster 不读 credit / score / rank / level', !/\bd\.(credit|score|rank|level|loan)\b/.test(drawSrc));
ok('海报没有「击败」类文案', !/击败|超过了|全国/.test(drawSrc));
ok('海报没有贷款 / 额度字样', !/贷款|可借|额度/.test(drawSrc));
ok('CTA 是邀请不是炫耀', /扫码加入我的自习室/.test(drawSrc));
ok('海报写明 24 小时有效', /24\s*小时内有效/.test(drawSrc));

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const openIdx = appSrc.indexOf('window.PQShare.open({');
const openBlock = appSrc.slice(openIdx, openIdx + 600);
ok('openSharePanel 没把信誉分传给海报', !/credit\.score|levelName|rank|points:/.test(openBlock));

/* ---------------- 3. 邀请码 24 小时 ---------------- */
console.log('\n【邀请码有效期】');
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => {
    store[k] = String(v);
  },
  removeItem: (k) => {
    delete store[k];
  },
};
global.window = { PQ_SHARE_URL: 'https://example.test/pq' };
global.document = { getElementById: () => null };
require('../web/share.js');
const Share = global.window.PQShare;

const inv1 = Share.invite();
ok('邀请码 8 位小写字母数字', /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(inv1.token));
ok('有效期 24 小时', Math.abs(inv1.exp - inv1.at - 86400000) < 1000);
ok('链接带 inv 和 exp', /inv=[a-z0-9]{8}&exp=\d+/.test(inv1.url));
ok('连续两次取同一个码（不刷码）', Share.invite().token === inv1.token);

const now = Date.now();
ok('过期链接判 expired', Share.checkLink('?inv=abc&exp=' + (now - 1000)).state === 'expired');
ok('有效链接判 ok 并给剩余小时', (() => {
  const r2 = Share.checkLink('?inv=abc&exp=' + (now + 3600e3));
  return r2.state === 'ok' && r2.leftH === 1;
})());
ok('无参数判 none', Share.checkLink('').state === 'none');
ok('exp 乱填判 none', Share.checkLink('?inv=abc&exp=xyz').state === 'none');

/* 过期后重新生成新码 */
store['pq-share-inv-v1'] = JSON.stringify({ token: 'aaaaaaaa', at: now - 90000000, exp: now - 1000 });
ok('过期后自动换新码', Share.invite().token !== 'aaaaaaaa');

/* ---------------- 4. 建团门槛 ---------------- */
console.log('\n【L2 才能自己开军团】');
const legionSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'legion.js'), 'utf8');
ok('create 里有 ≥100 的门槛', /cr\s*<\s*100/.test(legionSrc));
ok('门槛提示写了 L2 社交特权', /L2 社交特权/.test(legionSrc));
ok('错误文案说清楚要补打卡', /先把打卡补上/.test(legionSrc));

/* ---------------- 5. 三档特权在界面上有位置 ---------------- */
console.log('\n【界面接线】');
ok('成就页渲染三档特权', /function creditLevelHTML/.test(appSrc) && /creditLevelHTML\(\)/.test(appSrc));
ok('军团治理面板有「我的信誉位置」', /function govRepRankHTML/.test(appSrc) && /govRepRankHTML\(c\)/.test(appSrc));
ok('L3 星标在名册里', /function govStarChip/.test(appSrc) && /govStarChip\(m\.credit\)/.test(appSrc));
ok('裁定类职务挡住 <100 分的人', /纪律官|judge/.test(appSrc) && /L2（≥100 分）/.test(appSrc));
ok('index.html 引入了 credit-priv.js', fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8').includes('credit-priv.js'));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);
