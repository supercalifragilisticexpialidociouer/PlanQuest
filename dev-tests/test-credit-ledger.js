'use strict';
/* 信誉分账本测试（pq-core 口径，与桌面 main.js 同一套规则）
   覆盖：加分封顶、扣分、清零进失信期、三支柱统计、每日同类上限、记录上限。 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const store = {};
const ctx = {
  console, setInterval, setTimeout, clearInterval, clearTimeout,
  crypto: globalThis.crypto, TextEncoder, TextDecoder, Blob: globalThis.Blob, atob, btoa,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
  window: { addEventListener: () => {} },
  document: { createElement: () => ({ style: {}, addEventListener: () => {} }), addEventListener: () => {}, body: { appendChild: () => {} }, querySelector: () => null },
  navigator: { onLine: true },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('web/core/pq-core.js', 'utf8') + '\n;globalThis.__t={creditEvent,creditState,getData:()=>data,creditPillars};', ctx);
const t = ctx.__t;

let pass = 0;
const ok = (n, fn) => { fn(); pass++; console.log('  ✓ ' + n); };

ok('翻案被证实：+3，且当天封顶 6', () => {
  const a = t.creditEvent('flip_ok', '房间认可');
  assert.strictEqual(a.delta, 3);
  assert.strictEqual(a.score, 103);
  t.creditEvent('flip_ok', '房间认可');
  const c = t.creditEvent('flip_ok', '房间认可'); // 第 3 次应被上限截断
  assert.strictEqual(c.delta, 0);
  assert.strictEqual(t.getData().credit.score, 106, '一天最多记 6 分（2 次）');
});

ok('翻案被推翻：-8', () => {
  const before = t.getData().credit.score;
  const r = t.creditEvent('flip_bad', '房间否决');
  assert.strictEqual(r.delta, -8);
  assert.strictEqual(r.score, before - 8);
});

ok('恶意举报扣分且有上限', () => {
  const r = t.creditEvent('report_bad', '多次未核实');
  assert.ok(r.delta < 0);
  assert.ok(t.getData().credit.score < 100);
});

ok('贷款逾期：-30', () => {
  const before = t.getData().credit.score;
  const r = t.creditEvent('loan_bad', '逾期');
  assert.strictEqual(r.delta, -30);
  assert.ok(t.getData().credit.score < before);
});

ok('成长 / 联盟会计入三支柱', () => {
  t.creditEvent('help_ok', '感谢');
  t.creditEvent('growth_ok', '全勤');
  const p = t.creditPillars();
  assert.ok(p.ally >= 2, '联盟贡献应 >= 2');
  assert.ok(p.growth >= 1, '成长应 >= 1');
  const st = t.creditState();
  assert.ok(st.pillars && typeof st.pillars.honest === 'number');
});

ok('扣穿 0 分 → 进入负分缓冲并写失信期', () => {
  const d = t.getData();
  d.credit.score = 5;
  const r = t.creditEvent('flip_bad', '连续被推翻');
  assert.ok(r.score <= 0, '应扣到 0 或以下');
  assert.ok(r.score >= -30, '不会跌破 -30 的缓冲底');
  assert.ok((d.credit.blockUntil || 0) > Date.now(), '清零后必须写失信期');
  const st = t.creditState();
  assert.strictEqual(st.jailed, true);
});

ok('账本有条数上限与分项统计', () => {
  const d = t.getData();
  assert.ok(Array.isArray(d.credit.ledger) && d.credit.ledger.length > 0);
  assert.ok(d.credit.ledger.length <= 120);
  assert.ok(d.credit.rep.flips.bad >= 1);
  assert.ok(d.credit.rep.growth.ok >= 1);
});

console.log('\n结果：' + pass + ' 项全部通过');
process.exit(0);
