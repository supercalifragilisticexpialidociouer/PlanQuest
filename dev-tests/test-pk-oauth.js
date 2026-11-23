/* PlanQuest · GitHub 官方 OAuth（Device Flow）测试
 * 跑法：node dev-tests/test-pk-oauth.js
 */
'use strict';

const assert = require('assert');
const O = require('../src/pk-oauth');

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
async function okAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + '  →  ' + e.message);
  }
}

console.log('\n— 响应翻译 —');
ok('拿到 access_token', () => {
  const r = O.readTokenResponse({ json: { access_token: 'gho_abc', scope: 'repo' } });
  assert.equal(r.status, 'ok');
  assert.equal(r.token, 'gho_abc');
});
ok('authorization_pending → 继续等', () => {
  assert.equal(O.readTokenResponse({ json: { error: 'authorization_pending' } }).status, 'pending');
});
ok('slow_down → 降频而不是失败', () => {
  const r = O.readTokenResponse({ json: { error: 'slow_down' } });
  assert.equal(r.status, 'slow');
  assert.ok(r.message.includes('降频'));
});
ok('expired_token → 提示重新来', () => {
  assert.equal(O.readTokenResponse({ json: { error: 'expired_token' } }).status, 'expired');
});
ok('access_denied → 取消授权', () => {
  assert.equal(O.readTokenResponse({ json: { error: 'access_denied' } }).status, 'denied');
});
ok('incorrect_client_credentials → client_id 不对', () => {
  assert.equal(O.readTokenResponse({ json: { error: 'incorrect_client_credentials' } }).status, 'bad_client');
});
ok('device_flow_disabled → 提示去开开关', () => {
  const r = O.readTokenResponse({ json: { error: 'device_flow_disabled' } });
  assert.equal(r.status, 'disabled');
  assert.ok(r.message.includes('Device Flow'));
});
ok('完全连不上 → error 而不是抛异常', () => {
  const r = O.readTokenResponse({ status: 0, json: null });
  assert.equal(r.status, 'error');
});

console.log('\n— 完整流程（假 HTTP）—');
(async () => {
  await okAsync('start 解析出 user_code 与轮询间隔', async () => {
    const c = O.createClient({
      request: async (url) => {
        assert.ok(url.includes('/login/device/code'));
        return {
          status: 200,
          json: { device_code: 'dc123', user_code: 'ABCD-1234', verification_uri: O.VERIFY_URL, interval: 5, expires_in: 900 },
        };
      },
    });
    const r = await c.start({ clientId: 'Iv1.abc', scope: 'repo' });
    assert.equal(r.ok, true);
    assert.equal(r.userCode, 'ABCD-1234');
    assert.equal(r.interval, 5);
    assert.ok(r.message.includes('ABCD-1234'));
  });

  await okAsync('没有 client_id 时不发请求，直接提示', async () => {
    let called = 0;
    const c = O.createClient({ request: async () => { called++; return { json: {} }; } });
    const r = await c.start({ clientId: '' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'no_client');
    assert.equal(called, 0);
  });

  await okAsync('轮询：pending → ok', async () => {
    let n = 0;
    const c = O.createClient({
      request: async (url, body) => {
        assert.ok(url.includes('/login/oauth/access_token'));
        assert.equal(body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
        n += 1;
        return n === 1 ? { json: { error: 'authorization_pending' } } : { json: { access_token: 'gho_ok', scope: 'repo' } };
      },
    });
    const a = await c.pollOnce({ clientId: 'Iv1.abc', deviceCode: 'dc123' });
    assert.equal(a.status, 'pending');
    const b = await c.pollOnce({ clientId: 'Iv1.abc', deviceCode: 'dc123' });
    assert.equal(b.status, 'ok');
    assert.equal(b.token, 'gho_ok');
  });

  await okAsync('轮询参数缺失时不打网络', async () => {
    let called = 0;
    const c = O.createClient({ request: async () => { called++; return { json: {} }; } });
    const r = await c.pollOnce({ clientId: '', deviceCode: '' });
    assert.equal(r.status, 'error');
    assert.equal(called, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
