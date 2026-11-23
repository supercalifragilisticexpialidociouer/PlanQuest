'use strict';
/* 云同步客户端（桌面 / 安卓通用版）逻辑测试
 * 用假 DOM + 假云端 SDK 跑通：未登录、首次推送、远端更新、本机改动、冲突选择、应用后抑制回推
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const MODULE = path.join(__dirname, '..', 'src', 'renderer', 'pq-cloud.js');

/* ---------- 假环境 ---------- */
function makeEnv(opts) {
  const store = new Map(Object.entries(opts.meta || {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const document = {
    createElement: () => ({ set src(v) {}, set async(v) {}, get onload() { return null; }, set onload(v) {} }),
    head: { appendChild() {} },
    querySelector: () => null,
  };
  const window = {
    addEventListener() {},
    WorkBuddyCloud: opts.sdk,
  };
  return { store, localStorage, document, window };
}

function loadModule(env) {
  const code = fs.readFileSync(MODULE, 'utf8');
  const fn = new Function('window', 'document', 'localStorage', 'history', 'location', 'setTimeout', 'clearTimeout', 'URL', code);
  fn(
    env.window,
    env.document,
    env.localStorage,
    { replaceState() {} },
    { href: 'https://planquest-pwa.app.workbuddy.host/index.html' },
    setTimeout,
    clearTimeout,
    URL
  );
  return env.window.PQCloud;
}

/* ---------- 假云端 ---------- */
function makeCloud() {
  const db = { row: null, writes: 0, reads: 0 };
  const client = {
    database: {
      from() {
        return {
          select() {
            return {
              async maybeSingle() {
                db.reads++;
                return { data: db.row, error: null };
              },
            };
          },
          update(patch) {
            return {
              eq() {
                return {
                  async select() {
                    db.writes++;
                    db.row = { ...db.row, state: patch.state, updated_at: new Date().toISOString() };
                    return { data: [{ rev: (db.row.rev || 1) + 1, updated_at: db.row.updated_at }], error: null };
                  },
                };
              },
            };
          },
          insert(payload) {
            return {
              async select() {
                db.writes++;
                db.row = { id: 1, rev: 1, state: payload.state, updated_at: new Date().toISOString() };
                return { data: [{ rev: 1, updated_at: db.row.updated_at }], error: null };
              },
            };
          },
        };
      },
    },
    auth: {
      async getSession() {
        return this._session ? { data: this._session } : { data: null };
      },
      async signOut() {},
      _session: { user: { id: 'u1', name: '王同学', phoneNumber: '13800000000' } },
    },
  };
  return { client, db, sdk: { createWorkBuddyCloud: () => client } };
}

/* ---------- 样本数据 ---------- */
const localState = () => ({
  plans: [{ id: 'p1', title: '晨读' }],
  log: { '2026-11-01': { p1: { status: 'done', points: 20 } } },
  profile: { points: 20 },
  settings: { theme: 'dark' },
  guardian: { hash: 'secret-hash', whitelist: ['x'] },
  shop: { items: [], history: [], seeded: true },
});
const remoteState = () => ({
  plans: [{ id: 'p9', title: '云端计划' }],
  log: {},
  profile: { points: 88 },
  settings: { theme: 'light' },
});

function makeAdapter(state) {
  const a = { applied: [], reads: 0, current: JSON.parse(JSON.stringify(state)) };
  a.api = {
    cloudGet: async () => {
      a.reads++;
      return JSON.parse(JSON.stringify(a.current));
    },
    cloudApply: async (incoming) => {
      a.applied.push(JSON.parse(JSON.stringify(incoming)));
      a.current = JSON.parse(JSON.stringify(incoming));
      return { ok: true };
    },
    onLocalChange: (cb) => {
      a.emit = cb;
      return () => {};
    },
  };
  return a;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
function ok(name) {
  pass++;
  console.log('  ✓ ' + name);
}

(async () => {
  /* 1. 没有适配器时不启动 */
  {
    const env = makeEnv({ sdk: makeCloud().sdk });
    const PQ = loadModule(env);
    PQ.start({});
    assert.strictEqual(PQ.info().available, false);
    ok('本机接口没注入时不启用云同步');
  }

  /* 2. 云端没数据 → 首次把本机数据推上去，且不上传守护密码 */
  {
    const cloud = makeCloud();
    const env = makeEnv({ sdk: cloud.sdk });
    env.window.api = makeAdapter(localState()).api;
    const PQ = loadModule(env);
    PQ.start({});
    await wait(30);
    const r = await PQ.syncNow();
    assert.ok(r.ok, '同步应成功');
    assert.strictEqual(cloud.db.writes, 1, '应写入一次');
    assert.strictEqual(cloud.db.row.state.plans[0].title, '晨读');
    assert.strictEqual(cloud.db.row.state.guardian, undefined, '守护密码不应上传');
    ok('首次登录上传本机数据（守护密码留在本机）');
  }

  /* 3. 远端更新 → 覆盖本机 */
  {
    const cloud = makeCloud();
    cloud.db.row = { id: 1, rev: 3, state: remoteState(), updated_at: new Date(Date.now() - 60000).toISOString() };
    const adapter = makeAdapter(localState());
    const env = makeEnv({ sdk: cloud.sdk, meta: { 'pq-cloud-meta-v1': JSON.stringify({ lastSyncAt: Date.now() - 120000 }) } });
    env.window.api = adapter.api;
    const PQ = loadModule(env);
    let appliedHookCalled = false;
    PQ.start({ onApplied: () => (appliedHookCalled = true) });
    await wait(60);
    assert.strictEqual(adapter.applied.length, 1, '应把云端数据写回本机');
    assert.strictEqual(adapter.current.plans[0].title, '云端计划');
    assert.ok(appliedHookCalled, '应触发 onApplied 通知界面刷新');
    assert.strictEqual(cloud.db.writes, 0, '不应把刚拉下来的数据再推回去');
    ok('云端更新时覆盖本机，且不会回推');
  }

  /* 4. 本机改动 → 防抖后自动上传 */
  {
    const cloud = makeCloud();
    cloud.db.row = { id: 1, rev: 2, state: remoteState(), updated_at: new Date(Date.now() - 1000).toISOString() };
    const adapter = makeAdapter(localState());
    const env = makeEnv({ sdk: cloud.sdk, meta: { 'pq-cloud-meta-v1': JSON.stringify({ lastSyncAt: Date.now() - 500 }) } });
    env.window.api = adapter.api;
    const PQ = loadModule(env);
    PQ.start({});
    await wait(80);
    assert.strictEqual(PQ.info().signedIn, true, '应恢复登录态');
    adapter.current.profile.points = 120;
    PQ.notifyLocalChange();
    assert.strictEqual(PQ.info().dirty, true);
    await wait(1800);
    assert.strictEqual(cloud.db.writes, 1, '防抖后应自动上传一次');
    assert.strictEqual(cloud.db.row.state.profile.points, 120);
    ok('本机改动 1.5 秒后自动上传');
  }

  /* 5. 首次连接已有数据的账号：选「本机」→ 上传；选「云端」→ 覆盖 */
  {
    const cloud = makeCloud();
    cloud.db.row = { id: 1, rev: 4, state: remoteState(), updated_at: new Date().toISOString() };
    const adapter = makeAdapter(localState());
    const env = makeEnv({ sdk: cloud.sdk });
    env.window.api = adapter.api;
    const PQ = loadModule(env);
    PQ.start({ onConflict: async () => 'local' });
    await wait(80);
    assert.strictEqual(cloud.db.writes, 1, '选本机应上传');
    assert.strictEqual(cloud.db.row.state.plans[0].title, '晨读');
    assert.strictEqual(adapter.applied.length, 0);
    ok('首次连接冲突：选「本机」上传覆盖云端');
  }
  {
    const cloud = makeCloud();
    cloud.db.row = { id: 1, rev: 4, state: remoteState(), updated_at: new Date().toISOString() };
    const adapter = makeAdapter(localState());
    const env = makeEnv({ sdk: cloud.sdk });
    env.window.api = adapter.api;
    const PQ = loadModule(env);
    PQ.start({ onConflict: async () => 'remote' });
    await wait(80);
    assert.strictEqual(adapter.applied.length, 1, '选云端应写回本机');
    assert.strictEqual(adapter.current.plans[0].title, '云端计划');
    ok('首次连接冲突：选「云端」覆盖本机');
  }

  /* 6. 本机没真实数据时，首次登录直接采用云端，不弹冲突 */
  {
    const cloud = makeCloud();
    cloud.db.row = { id: 1, rev: 4, state: remoteState(), updated_at: new Date().toISOString() };
    const adapter = makeAdapter({ plans: [{ id: 'demo-1', title: '示例' }], log: {}, profile: { points: 0 } });
    const env = makeEnv({ sdk: cloud.sdk });
    env.window.api = adapter.api;
    const PQ = loadModule(env);
    let asked = false;
    PQ.start({ onConflict: async () => ((asked = true), 'local') });
    await wait(80);
    assert.strictEqual(asked, false, '本机只有示例数据时不该弹冲突');
    assert.strictEqual(adapter.current.plans[0].title, '云端计划');
    ok('新设备首次登录直接采用云端数据');
  }

  /* 7. 退出登录：清状态但不动本机数据 */
  {
    const cloud = makeCloud();
    cloud.db.row = { id: 1, rev: 1, state: remoteState(), updated_at: new Date(Date.now() - 5000).toISOString() };
    const adapter = makeAdapter(localState());
    const env = makeEnv({ sdk: cloud.sdk, meta: { 'pq-cloud-meta-v1': JSON.stringify({ lastSyncAt: Date.now() - 1000 }) } });
    env.window.api = adapter.api;
    const PQ = loadModule(env);
    PQ.start({});
    await wait(60);
    await PQ.signOut();
    assert.strictEqual(PQ.info().signedIn, false);
    assert.strictEqual(adapter.current.plans[0].title, '晨读', '本机数据应保留');
    const before = cloud.db.writes;
    adapter.current.profile.points = 5;
    PQ.notifyLocalChange();
    await wait(1800);
    assert.strictEqual(cloud.db.writes, before, '退出后不应再上传');
    ok('退出登录后不再上传，本机数据保留');
  }

  /* 8. 面板 HTML：未登录显示手机号表单，登录后显示状态 */
  {
    const cloud = makeCloud();
    cloud.db.row = { id: 1, rev: 1, state: remoteState(), updated_at: new Date().toISOString() };
    const env = makeEnv({ sdk: cloud.sdk });
    env.window.api = makeAdapter(localState()).api;
    const PQ = loadModule(env);
    PQ.start({});
    await wait(60);
    const loggedIn = PQ.panelHTML();
    assert.ok(/云同步/.test(loggedIn) && /cloud-sync/.test(loggedIn), '登录后应显示同步按钮');
    assert.ok(/138\*\*\*\*0000/.test(loggedIn), '手机号应打码');
    await PQ.signOut();
    const loggedOut = PQ.panelHTML();
    assert.ok(/cloud-phone/.test(loggedOut) && /cloud-login/.test(loggedOut), '未登录应显示手机号表单');
    ok('设置页面板 HTML 正常（手机号打码）');
  }

  console.log(`\n云同步客户端逻辑：${pass} 组全部通过`);
})().catch((e) => {
  console.error('测试失败：', e && e.message);
  process.exit(1);
});
