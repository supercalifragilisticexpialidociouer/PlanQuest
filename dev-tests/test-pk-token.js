/* PlanQuest · GitHub token 自动获取测试
 * 跑法：node dev-tests/test-pk-token.js
 */
'use strict';

const assert = require('assert');
const T = require('../src/pk-token');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + '  →  ' + e.message);
  }
}

const FAKE = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

console.log('\n— 格式判定 —');
ok('接受 gh*_ 前缀 token', () => assert.equal(T.looksLikeToken(FAKE), true));
ok('接受 github_pat_', () => assert.equal(T.looksLikeToken('github_pat_' + 'x'.repeat(30)), true));
ok('接受 40 位十六进制老 token', () => assert.equal(T.looksLikeToken('a'.repeat(40)), true));
ok('拒绝空格/过短/乱码', () => {
  assert.equal(T.looksLikeToken('abc def ghi jkl mno pqr'), false);
  assert.equal(T.looksLikeToken('short'), false);
  assert.equal(T.looksLikeToken(''), false);
});
ok('掩码保留头尾', () => {
  const m = T.mask(FAKE);
  assert.ok(m.startsWith('ghp_a1'));
  assert.ok(m.includes('****'));
  assert.ok(m.endsWith(FAKE.slice(-4)));
});

console.log('\n— 来源优先级 —');
ok('环境变量优先于设置', () => {
  process.env.GITHUB_TOKEN = FAKE;
  T.clear();
  const r = T.resolve({ stored: 'ghp_' + 'z'.repeat(36) });
  assert.equal(r.source, 'env');
  assert.equal(r.token, FAKE);
  delete process.env.GITHUB_TOKEN;
});

ok('官方 OAuth 存下的 token 优先于读本机 CLI', () => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  T.clear();
  const r = T.resolve({ stored: FAKE });
  assert.equal(r.source, 'stored');
  assert.equal(r.token, FAKE);
});

ok('什么都没有时给出可操作的提示，不抛异常', () => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  T.clear();
  const r = T.resolve({ stored: 'not-a-token' });
  if (r.source === 'none') {
    assert.equal(r.token, '');
    assert.ok(r.hint.length > 0);
  }
});

ok('status 不返回完整 token', () => {
  process.env.GITHUB_TOKEN = FAKE;
  T.clear();
  const s = T.status('');
  assert.ok(!JSON.stringify(s).includes(FAKE));
  assert.equal(s.ok, true);
  delete process.env.GITHUB_TOKEN;
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
