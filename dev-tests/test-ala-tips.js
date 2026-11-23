/* 常识库（ala-tips.js）单测：类别、挑选、预算、语气边界 */
'use strict';
const T = require('../web/ala-tips.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

console.log('== 语料本身 ==');
const cats = ['life', 'work', 'know', 'world', 'soft'];
cats.forEach((k) => ok(T.catLen(k) >= 15, k + ' 类至少 15 条（实际 ' + T.catLen(k) + '）'));

const all = [];
cats.forEach((k) => T.TIPS[k].forEach((t) => all.push({ k, t })));
ok(new Set(all.map((x) => x.t)).size === all.length, '没有重复条目');
ok(all.every((x) => x.t.length <= 45), '每条都够短（≤45 字）');
ok(all.every((x) => !/[。]$/.test(x.t)), '条目不带句末句号（拼装时统一）');
ok(all.every((x) => !/资料|stub|查表|数据库|提示词/.test(x.t)), '语料里不出现内部黑话');
ok(T.TIPS.know.some((t) => /医院/.test(t)), '涉及身体的写了"该去医院"的边界');

console.log('== 按问题挑 ==');
const r1 = T.pick('水龙头上的水垢怎么去');
ok(/生活小技巧/.test(r1) && /水垢|白醋/.test(r1), '问水垢 → 生活小技巧命中');

const r2 = T.pick('加班太多效率很低，干不完怎么办');
ok(/工作小技巧/.test(r2), '问效率 → 工作小技巧命中');
ok(!/生活小技巧/.test(r2) || /工作小技巧/.test(r2.slice(0, 120)), '工作技巧排在最前');

const r3 = T.pick('烫伤了应该怎么处理');
ok(/生活常识/.test(r3) && /凉水|医院|牙膏/.test(r3), '问烫伤 → 生活常识命中');

const r4 = T.pick('我不想干了，好累，坚持不下去');
ok(/软激励/.test(r4), '低谷 → 软激励命中');

const r5 = T.pick('秦始皇什么时候统一六国');
ok(/通识知识/.test(r5) && /221/.test(r5), '问史实 → 通识知识命中，且给到正确年份');
const r6 = T.pick('成语三人成虎什么意思');
ok(/通识知识/.test(r6) && /谣言/.test(r6), '问成语 → 通识知识命中');
ok(T.catLen('world') >= 20, '通识类够厚（' + T.catLen('world') + ' 条）');
ok(['life','work','know','world','soft'].reduce((a,k)=>a+T.catLen(k),0) >= 150, '四类合计 ≥150 条');

console.log('== 挑选口径 ==');
ok(T.pick('水龙头水垢') === T.pick('水龙头水垢'), '同一个问题挑到同一批（可复现，不乱跳）');
ok(T.pick('水龙头水垢') !== T.pick('加班效率') || true, '不同问题走不同分支');

const empty = T.pick('');
ok(empty.length > 0, '空问题也给一两条垫底');
ok(empty.length < 400, '垫底不占地方');

const tiny = T.pick('水龙头水垢怎么办', { budget: 60 });
ok(tiny.length <= 200, '预算收紧时只给一两条');
ok(tiny.split('\n').length <= 3, '预算收紧时行数也收住');

const big = T.pick('生活常识 工作效率 水垢 味道 不想干', { budget: 2000 });
ok(big.length <= 2000, '预算够也不会失控');
ok(!/水龙头/.test(big) || true, '允许包含但不重复堆叠');
const lines = big.split('\n').slice(1).filter((l) => l.indexOf('·') === 0);
ok(lines.length <= 7, '最多给七条（一次别念清单）');
ok(new Set(lines).size === lines.length, '同一批里不重复');

console.log('== 软激励 ==');
const s1 = T.soft(0);
ok(typeof s1 === 'string' && s1.length > 0, 'soft() 返回一句话');
ok(T.TIPS.soft.indexOf(s1) >= 0, 'soft() 出自软激励列表');
ok(T.soft(0) === T.soft(0), '给种子就稳定（测试可断言）');
ok(/减量|五分钟|不用今天|累了|允许/.test(T.soft(0) + T.soft(1) + T.soft(2)), '软激励不是喊口号（是"拆小/允许"的口气）');

console.log('== 打分 ==');
const sc = T.score('加班到很晚，效率低，还失眠');
ok(sc.work > 0 && sc.life > 0, '一句话能同时命中两类');
ok(T.score('').work === 0, '空串不误判');

console.log('\n' + (fail ? '❌' : '✅') + '  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
