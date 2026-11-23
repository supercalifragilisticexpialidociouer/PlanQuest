/* 云同步逻辑测试（Node，无浏览器）
 * 用假的 SDK + 假数据库跑通：登录前不联网、首次上传、远端更新覆盖本机、本地改动回推、退出登录。
 * 运行： node dev-tests/test-cloud.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');

/* ---------------- 假环境 ---------------- */
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const listeners = {};
const window = {
  addEventListener: (t, fn) => ((listeners[t] = listeners[t] || []).push(fn)),
  NativeGuard: undefined,
};

const document = {
  head: { appendChild: () => {} },
  createElement: () => ({ set src(v) {}, set async(v) {}, set onload(v) {}, set onerror(v) {} }),
};

const location = { href: 'https://planquest-pwa.app.workbuddy.host/' };
const history = { replaceState() {} };

/* 假数据库：单行表 pq_state */
const db = {
  row: null,
  calls: [],
  clock: Date.parse('2026-11-01T08:00:00Z'),
  tick() {
    this.clock += 60000;
    return new Date(this.clock).toISOString();
  },
};

function makeClient() {
  function table(name) {
    const q = { op: 'select', payload: null, filters: [] };
    const api = {
      select() {
        return api;
      },
      insert(p) {
        q.op = 'insert';
        q.payload = p;
        return api;
      },
      update(p) {
        q.op = 'update';
        q.payload = p;
        return api;
      },
      upsert(p) {
        q.op = 'upsert';
        q.payload = p;
        return api;
      },
      eq(c, v) {
        q.filters.push([c, v]);
        return api;
      },
      maybeSingle() {
        return exec(true);
      },
      then(res, rej) {
        return exec(false).then(res, rej);
      },
    };
    async function exec(single) {
      db.calls.push({ table: name, op: q.op, payload: q.payload });
      if (q.op === 'select') {
        return { data: db.row ? { ...db.row, state: db.row.state } : null, error: null };
      }
      if (q.op === 'insert') {
        if (db.row) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        db.row = { id: 1, owner_id: 'u-test', state: q.payload.state, memo: q.payload.owner_name, rev: 1, updated_at: db.tick() };
        return { data: [{ rev: db.row.rev, updated_at: db.row.updated_at }], error: null };
      }
      if (q.op === 'update') {
        if (!db.row) return { data: [], error: null };
        db.row.state = q.payload.state;
        db.row.memo = q.payload.owner_name;
        db.row.rev += 1;
        db.row.updated_at = db.tick();
        return { data: [{ rev: db.row.rev, updated_at: db.row.updated_at }], error: null };
      }
      return { data: null, error: { message: 'unsupported' } };
    }
    return api;
  }

  const auth = {
    _session: null,
    async getSession() {
      return { data: this._session, error: null };
    },
    async sendOtp({ phone }) {
      if (!/^1\d{10}$/.test(phone)) return { data: null, error: { message: 'bad phone' } };
      return { data: { verificationId: 'vid-1', isExistingUser: false }, error: null };
    },
    async verifyOtp({ token }) {
      if (token !== '123456') return { data: null, error: { message: '验证码不正确' } };
      this._session = { user: { id: 'u-test', name: '测试用户', phoneNumber: '13800001111' } };
      return { data: { session: this._session }, error: null };
    },
    async signOut() {
      this._session = null;
      return { error: null };
    },
    handleWorkBuddyCallback: null,
    async signInWithOAuth() {
      return { data: { url: 'https://relay.example/authorize' }, error: null };
    },
  };

  return { database: { from: table }, auth };
}

window.WorkBuddyCloud = { createWorkBuddyCloud: () => makeClient() };

/* ---------------- 加载代码（同一作用域，模拟浏览器的全局词法环境） ---------------- */
const src =
  fs.readFileSync(path.join(WEB, 'core', 'pq-core.js'), 'utf8') +
  '\n' +
  fs.readFileSync(path.join(WEB, 'core', 'pq-cloud.js'), 'utf8');

const noop = () => 0;
const factory = new Function(
  'window',
  'document',
  'localStorage',
  'location',
  'history',
  'URL',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'console',
  src +
    '\nreturn { getData: () => data, setData: (v) => { data = v; }, saveNow, emitState, normalize, PQCloud: window.PQCloud };'
);

const ctx = factory(
  window,
  document,
  localStorage,
  location,
  history,
  URL,
  (fn) => setTimeout(fn, 0),
  (t) => clearTimeout(t),
  noop,
  console
);

/* ---------------- 断言 ---------------- */
let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log('  PASS ' + label);
  } else {
    fails.push(label);
    console.log('  FAIL ' + label);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n[1] 未登录时：本地改动不产生任何云端请求');
  ctx.setData(ctx.normalize({ plans: [{ id: 'p-1', title: '跑步', time: '07:00', days: [0, 1, 2, 3, 4, 5, 6], points: 20, enabled: true }] }));
  ctx.saveNow();
  const before = db.calls.length;
  ctx.PQCloud.start({});
  await sleep(30);
  ok(db.calls.length === before, '未登录时没有发起 select/insert/update');
  ok(ctx.PQCloud.info().signedIn === false, 'start 后仍未登录');
  ok(ctx.PQCloud.info().available === true, 'SDK 可用');

  console.log('\n[2] 手机号校验 + 验证码错误不建立会话');
  let r = await ctx.PQCloud.sendPhoneCode('12345');
  ok(r.ok === false && /11 位/.test(r.message), '非法手机号被拦下且不发请求');
  r = await ctx.PQCloud.sendPhoneCode('13800001111');
  ok(r.ok === true, '合法手机号发送成功');
  r = await ctx.PQCloud.submitPhoneCode('000000');
  ok(r.ok === false && ctx.PQCloud.info().signedIn === false, '验证码错误保持未登录');

  console.log('\n[3] 首次登录 + 云端为空 → 把本机数据传上去');
  r = await ctx.PQCloud.submitPhoneCode('123456');
  await sleep(30);
  ok(r.ok === true, '登录成功');
  ok(ctx.PQCloud.info().signedIn === true, '会话已建立');
  const ops = db.calls.map((c) => c.op);
  ok(ops.includes('insert'), '首次同步走了 insert');
  ok(!!db.row && db.row.state.plans && db.row.state.plans.length === 1, '云端存下了本机的 1 个计划');
  ok(!!ctx.PQCloud.info().lastSyncAt, '记录了同步时间');

  console.log('\n[4] 另一台设备改了云端 → 本机拉取覆盖');
  db.row.state = {
    ...db.row.state,
    plans: db.row.state.plans.concat([{ id: 'p-2', title: '读书', time: '21:00', days: [0], points: 15, enabled: true }]),
  };
  db.row.updated_at = db.tick(); // 比本机 lastSyncAt 新
  r = await ctx.PQCloud.syncNow();
  await sleep(20);
  ok(r.ok === true, '同步返回成功');
  ok(ctx.getData().plans.length === 2, '本机采纳了云端的新计划（2 个）');

  console.log('\n[5] 本机改动 → 防抖后自动回推');
  const callsBefore = db.calls.length;
  ctx.getData().profile.points = 55;
  ctx.saveNow();
  await sleep(2600); // 等 1.5s 防抖
  ok(db.calls.length > callsBefore, '本地改动触发了云端写入');
  ok(db.row.state.profile.points === 55, '云端已是最新积分');

  console.log('\n[6] 退出登录：保留本机数据，不再上传');
  r = await ctx.PQCloud.signOut();
  await sleep(20);
  ok(r.ok === true && ctx.PQCloud.info().signedIn === false, '已退出');
  ok(ctx.getData().plans.length === 2, '本机数据仍在');
  const afterSignOut = db.calls.length;
  ctx.saveNow();
  await sleep(2000);
  ok(db.calls.length === afterSignOut, '退出后不再写云端');

  console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
  if (fails.length) {
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
})();
