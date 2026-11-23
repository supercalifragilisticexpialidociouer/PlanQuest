/* PlanQuest 云同步模块（桌面版 / 安卓版通用）
 * 与网页版共用同一个云环境、同一张 pq_state 表、同一个账号体系。
 *
 * 设计要点：
 *  1) 平台无关：本机数据怎么读、怎么写由各端注入（adapter），模块只管云端；
 *     · 桌面版 → window.api.cloudGet / cloudApply（主进程读写 data.json）
 *     · 安卓版 → window.pqLocalGet / pqLocalApply（pq-core 读写 localStorage）
 *  2) 本地优先：业务照旧写本机，改动后防抖推云端；登录/启动时按 updated_at 拉取；
 *     未登录、离线、云端组件加载失败时，完全不影响本机使用。
 *  3) 设备本地字段（守护密码、开机自启、主题等）不跟随云端，由平台的 apply 实现保留。
 */
'use strict';

window.PQCloud = (() => {
  /* 云服务公开配置：可随前端一起分发（不含任何私钥） */
  const PUBLIC_CONFIG = {
    endpoint: 'https://planquest-pwa.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_PFmOcAFXeaCjcrwX348z9K_GzL2rQYXrxw0yfIor7CN7boW74hreqVT',
  };

  const TABLE = 'pq_state';
  const INIT_PROFILE_POINTS = 100; // 新用户初始积分（与 core 默认数据保持一致）
  const META_KEY = 'pq-cloud-meta-v1';
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
  const PUSH_DELAY = 1500;
  const APPLY_GUARD = 1200; // 应用云端数据后，短时间内忽略本机变更回调

  let client = null;
  let sdkMissing = '';
  let session = null;
  let pendingOtp = null;
  let status = 'local'; // local | syncing | synced | error
  let message = '未登录';
  let lastSyncAt = 0;
  let dirty = false;
  let applying = false;
  let applyGuardUntil = 0;
  let busy = false;
  let pushTimer = null;
  let started = false;
  let allowWorkBuddy = true; // 网页版 / 手机版可走 WorkBuddy 授权登录；桌面版（file:// 页面）不提供
  let conflictResolver = null;
  let appliedHook = null;
  const listeners = [];

  /* ---------- 平台适配层 ---------- */
  function resolveAdapter() {
    const api = window.api || {};
    if (typeof api.cloudGet === 'function' && typeof api.cloudApply === 'function') {
      return {
        name: 'desktop',
        get: () => api.cloudGet(),
        apply: (obj) => api.cloudApply(obj),
        subscribe: typeof api.onLocalChange === 'function' ? (cb) => api.onLocalChange(cb) : null,
      };
    }
    if (typeof window.pqLocalGet === 'function' && typeof window.pqLocalApply === 'function') {
      return {
        name: 'mobile',
        get: () => window.pqLocalGet(),
        apply: (obj) => window.pqLocalApply(obj),
        subscribe: null, // pq-core 的 saveNow 会直接回调 notifyLocalChange
      };
    }
    return null;
  }

  async function localSnapshot() {
    const a = resolveAdapter();
    if (!a) throw new Error('本机数据接口还没准备好');
    const raw = await a.get();
    return raw && typeof raw === 'object' ? raw : null;
  }

  async function applyLocal(obj) {
    const a = resolveAdapter();
    if (!a) throw new Error('本机数据接口还没准备好');
    applying = true;
    try {
      const r = await a.apply(obj);
      return r || { ok: true };
    } finally {
      applying = false;
      applyGuardUntil = Date.now() + APPLY_GUARD;
    }
  }

  /* ---------- 元信息（只存上次同步时间与账号标识，不含 token） ---------- */
  function readMeta() {
    try {
      const raw = localStorage.getItem(META_KEY);
      const m = raw ? JSON.parse(raw) : null;
      if (m && typeof m === 'object') lastSyncAt = Number(m.lastSyncAt) || 0;
    } catch (e) {}
  }
  function persistMeta() {
    try {
      localStorage.setItem(
        META_KEY,
        JSON.stringify({ lastSyncAt: lastSyncAt || 0, uid: (session && session.user && session.user.id) || '' })
      );
    } catch (e) {}
  }

  /* ---------- 状态通知 ---------- */
  function info() {
    const u = (session && session.user) || null;
    return {
      available: !!client,
      sdkMissing,
      signedIn: !!session,
      user: u ? { name: u.name || '', phone: u.phoneNumber || u.phone || '', email: u.email || '', avatar: u.avatarUrl || '' } : null,
      status,
      message,
      lastSyncAt,
      dirty,
    };
  }
  function setStatus(s, m) {
    status = s;
    if (m !== undefined) message = m;
    emit();
  }
  function emit() {
    const i = info();
    listeners.forEach((fn) => {
      try {
        fn(i);
      } catch (e) {}
    });
  }
  function onChange(cb) {
    if (typeof cb === 'function') listeners.push(cb);
    return () => {
      const k = listeners.indexOf(cb);
      if (k >= 0) listeners.splice(k, 1);
    };
  }

  /* ---------- 错误归类（只留人话） ---------- */
  function describeError(err) {
    if (!err) return '同步失败，请稍后重试';
    const code = err.code || err.status || '';
    const text = String(err.message || '');
    if (code === '42P01' || /relation .* does not exist/i.test(text)) return '云端数据表尚未就绪';
    if (code === '42501' || /row-level security|permission denied/i.test(text)) return '数据不属于当前账号，已拒绝访问';
    if (code === 401 || /unauthor|token|session/i.test(text)) return '登录已过期，请重新登录';
    if (/network|failed to fetch|timeout|offline|load failed/i.test(text)) return '网络不通，稍后会自动重试';
    return text || '同步失败，请稍后重试';
  }
  function fail(err) {
    const m = describeError(err);
    setStatus('error', m);
    return { ok: false, message: m };
  }

  /* ---------- 云端读写（身份由服务端按登录态判定，前端不传 owner_id） ---------- */
  async function dbFetch() {
    const { data: row, error } = await client.database.from(TABLE).select('id,state,rev,updated_at').maybeSingle();
    if (error) throw error;
    return row || null;
  }

  async function dbPush() {
    const state = await localSnapshot();
    if (!state) throw new Error('本机数据还没准备好');
    // 守护密码哈希只留本机，不上传
    const payload = { ...state };
    delete payload.guardian;
    const ownerName = (session && session.user && session.user.name) || null;
    const existing = await dbFetch();
    if (existing) {
      const { data: rows, error } = await client.database
        .from(TABLE)
        .update({ state: payload, owner_name: ownerName })
        .eq('id', existing.id)
        .select('rev,updated_at');
      if (error) throw error;
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('云端拒绝了这次写入（数据不属于当前账号）');
      return rows[0];
    }
    const { data: rows, error } = await client.database.from(TABLE).insert({ state: payload, owner_name: ownerName }).select('rev,updated_at');
    if (error) throw error;
    return Array.isArray(rows) ? rows[0] : rows;
  }

  /* ---------- 合并策略 ---------- */
  async function hasLocalData() {
    let s = null;
    try {
      s = await localSnapshot();
    } catch (e) {
      return false;
    }
    if (!s) return false;
    // 示例计划 / 仅初始积分不算「真实数据」，避免新设备首次登录就弹合并提示
    const realPlans = Array.isArray(s.plans) ? s.plans.filter((p) => p && !/^demo-/.test(String(p.id))).length : 0;
    const logs = s.log && typeof s.log === 'object' ? Object.keys(s.log).length : 0;
    const points = Number(s.profile && s.profile.points) || 0;
    return realPlans > 0 || logs > 0 || points !== INIT_PROFILE_POINTS;
  }

  async function adopt(remote) {
    const r = await applyLocal(remote.state && typeof remote.state === 'object' ? remote.state : {});
    if (r && r.ok === false) throw new Error(r.message || '写入本机失败');
    dirty = false;
    lastSyncAt = Date.parse(remote.updated_at) || Date.now();
    persistMeta();
    if (typeof appliedHook === 'function') {
      try {
        appliedHook();
      } catch (e) {}
    }
    setStatus('synced', '已从云端恢复');
  }

  async function push() {
    const row = await dbPush();
    if (!row) throw new Error('云端未返回写入结果');
    dirty = false;
    lastSyncAt = Date.parse(row.updated_at) || Date.now();
    persistMeta();
    setStatus('synced', '已同步到云端');
  }

  async function runSync() {
    if (busy) return { ok: true, skipped: true };
    if (!client) return { ok: false, message: sdkMissing || '云服务暂不可用' };
    if (!session) return { ok: false, message: '请先登录' };
    busy = true;
    setStatus('syncing', '正在同步…');
    try {
      const remote = await dbFetch();
      if (!remote) {
        await push(); // 云端还没有数据：先把本机数据带上去
        return { ok: true };
      }
      const remoteAt = Date.parse(remote.updated_at) || 0;
      if (!lastSyncAt) {
        // 首次连接这个账号：云端与本机都有数据时让用户选
        if (!(await hasLocalData())) {
          await adopt(remote);
        } else {
          let choice = 'remote';
          try {
            if (typeof conflictResolver === 'function') choice = await conflictResolver();
          } catch (e) {
            choice = 'remote';
          }
          if (choice === 'local') await push();
          else await adopt(remote);
        }
        return { ok: true };
      }
      if (remoteAt > lastSyncAt) {
        await adopt(remote);
        return { ok: true };
      }
      if (dirty) {
        await push();
        return { ok: true };
      }
      setStatus('synced', '已是最新');
      return { ok: true };
    } catch (e) {
      return fail(e);
    } finally {
      busy = false;
      emit();
    }
  }

  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (session && dirty) runSync();
    }, PUSH_DELAY);
  }

  /* ---------- 供各端调用：本机数据变了 ---------- */
  function notifyLocalChange() {
    if (applying || Date.now() < applyGuardUntil) return;
    dirty = true;
    if (!session) {
      if (status !== 'local') setStatus('local', '未登录');
      return;
    }
    schedulePush();
  }

  /* ---------- 登录流程 ---------- */
  // 清掉地址栏里的登录回调参数（桌面版是 file:// 页面，replaceState 可能被拒绝，忽略即可）
  function cleanUrl(keys) {
    try {
      const url = new URL(location.href);
      keys.forEach((k) => url.searchParams.delete(k));
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (e) {}
  }

  async function handleCallback() {
    let url;
    try {
      url = new URL(location.href);
    } catch (e) {
      return { handled: false };
    }
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) return { handled: false };
    const provider = url.searchParams.get('provider');
    if (provider !== 'workbuddy') {
      cleanUrl(['code', 'state', 'provider', 'error', 'error_description']);
      return { handled: true, error: '授权回调缺少有效的登录方式，请重新登录' };
    }
    const handler = client.auth.handleWorkBuddyCallback;
    if (typeof handler !== 'function') return { handled: true, error: '当前云端组件不支持该登录方式，请重试' };
    const { data: s, error } = await handler.call(client.auth);
    if (error) return { handled: true, error: error.message || '登录失败，请重试' };
    if (s) {
      cleanUrl(['code', 'state', 'provider']);
      session = s;
      persistMeta();
      return { handled: true };
    }
    return { handled: true };
  }

  async function afterSignIn() {
    persistMeta();
    emit();
    await runSync();
  }

  async function sendPhoneCode(phone) {
    if (!client) return { ok: false, message: sdkMissing || '云服务暂不可用' };
    const value = String(phone || '').trim();
    if (!/^1\d{10}$/.test(value)) return { ok: false, message: '请输入正确的 11 位手机号' };
    try {
      const sent = await client.auth.sendOtp({ phone: value });
      if (sent.error) return { ok: false, message: sent.error.message || '验证码发送失败' };
      pendingOtp = { phone: value, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser };
      return { ok: true, message: '验证码已发送' };
    } catch (e) {
      return { ok: false, message: describeError(e) };
    }
  }

  async function submitPhoneCode(code) {
    if (!client) return { ok: false, message: sdkMissing || '云服务暂不可用' };
    if (!pendingOtp) return { ok: false, message: '请先获取验证码' };
    const token = String(code || '').trim();
    if (!token) return { ok: false, message: '请输入验证码' };
    try {
      const res = await client.auth.verifyOtp({
        phone: pendingOtp.phone,
        verificationId: pendingOtp.verificationId,
        isExistingUser: pendingOtp.isExistingUser,
        token,
      });
      if (res.error) return { ok: false, message: res.error.message || '验证码不正确或已过期' };
      pendingOtp = null;
      session = res.data && res.data.session ? res.data.session : res.data;
      await afterSignIn();
      return { ok: true };
    } catch (e) {
      return { ok: false, message: describeError(e) };
    }
  }

  function signInWithWorkBuddy() {
    if (!client) return Promise.resolve({ ok: false, message: sdkMissing || '云服务暂不可用' });
    const back = new URL(location.href);
    ['code', 'state', 'provider'].forEach((k) => back.searchParams.delete(k));
    return client.auth
      .signInWithOAuth({ provider: 'workbuddy', redirectTo: back.toString() })
      .then(({ data: d, error }) => {
        if (error) return { ok: false, message: error.message || '暂时无法使用该方式登录' };
        location.assign(d.url); // 同一个页面跳转，PKCE 凭据才不会丢
        return { ok: true };
      })
      .catch((e) => ({ ok: false, message: describeError(e) }));
  }

  async function signOut() {
    try {
      if (client) await client.auth.signOut();
    } catch (e) {}
    session = null;
    pendingOtp = null;
    lastSyncAt = 0;
    dirty = false;
    persistMeta();
    setStatus('local', '已退出登录');
    emit();
    return { ok: true };
  }

  /* ---------- 启动 ---------- */
  // 云端 SDK 优先用随应用内置的副本（离线 / 国内网络也能用），加载失败才回落到 CDN
  const LOCAL_SDK = 'vendor/workbuddy-cloud.js';

  function hasSdk() {
    return !!(window.WorkBuddyCloud && typeof window.WorkBuddyCloud.createWorkBuddyCloud === 'function');
  }

  function injectScript(src, timeoutMs) {
    return new Promise((resolve) => {
      if (hasSdk()) return resolve(true);
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => finish(hasSdk());
      el.onerror = () => finish(false);
      document.head.appendChild(el);
      setTimeout(() => finish(hasSdk()), timeoutMs);
    });
  }

  async function loadSdk() {
    if (hasSdk()) return true;
    if (await injectScript(LOCAL_SDK, 4000)) return true;
    return injectScript(SDK_URL, 8000);
  }

  async function boot() {
    const ok = await loadSdk();
    if (!ok) {
      sdkMissing = '云端组件没加载成功（网络受限或未联网），本机功能不受影响';
      setStatus('local', sdkMissing);
      return;
    }
    try {
      client = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: PUBLIC_CONFIG.endpoint,
        oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
        publishableKey: PUBLIC_CONFIG.publishableKey,
      });
    } catch (e) {
      sdkMissing = '云端组件初始化失败，本机功能不受影响';
      setStatus('local', sdkMissing);
      return;
    }
    emit();
    try {
      const cb = await handleCallback();
      if (cb.handled && cb.error) {
        setStatus('error', cb.error);
        return;
      }
      const got = await client.auth.getSession();
      if (got && got.data) {
        session = got.data;
        await afterSignIn();
      } else {
        setStatus('local', '未登录（数据只保存在本机）');
      }
    } catch (e) {
      fail(e);
    }
  }

  function start(opts) {
    if (started) return;
    if (!resolveAdapter()) return; // 本机数据接口没注入，不启用云同步
    started = true;
    if (opts) {
      if (opts.workbuddyLogin === false) allowWorkBuddy = false;
      if (typeof opts.onConflict === 'function') conflictResolver = opts.onConflict;
      if (typeof opts.onApplied === 'function') appliedHook = opts.onApplied;
      if (typeof opts.onChange === 'function') onChange(opts.onChange);
    }

    readMeta();
    setStatus('local', '正在连接云端…');

    const a = resolveAdapter();
    if (a && a.subscribe) {
      a.subscribe(() => notifyLocalChange());
    }

    boot();

    window.addEventListener('online', () => {
      if (session && dirty) runSync();
    });
  }

  /* ---------- 设置页面板（各端共用同一套 DOM 与样式） ---------- */
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function maskPhone(v) {
    const s = String(v || '');
    return /^\d{11}$/.test(s) ? s.slice(0, 3) + '****' + s.slice(7) : s;
  }

  function fmtTime(ts) {
    if (!ts) return '还没同步过';
    const d = new Date(Number(ts));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function panelHTML() {
    const c = info();
    const head = '<h3>云同步 <span class="cloud-pill">跨设备</span></h3>';

    if (!c.available) {
      return `<div class="panel">${head}
        <div class="sd">${esc(c.sdkMissing || '云端暂时连不上')}。<br/>本机打卡、积分、商城都照常可用。</div>
      </div>`;
    }

    if (!c.signedIn) {
      return `<div class="panel">${head}
        <div class="sd" style="margin-bottom:12px">登录后打卡记录会保存到云端，手机、平板、电脑之间自动同步，重装也能找回。不登录也能正常用，数据只在本机。</div>
        <div class="cloud-form">
          <input class="input" id="cloud-phone" type="tel" inputmode="numeric" maxlength="11" placeholder="手机号" autocomplete="tel" />
          <button class="btn small ghost" id="cloud-send" type="button">获取验证码</button>
          <input class="input" id="cloud-code" inputmode="numeric" maxlength="6" placeholder="验证码" autocomplete="one-time-code" />
          <button class="btn small" id="cloud-login" type="button">登录 / 注册</button>
        </div>
        <div class="cloud-msg" id="cloud-msg"></div>
        ${
          allowWorkBuddy
            ? `<div class="set-row" style="border-bottom:0">
          <div class="set-info">
            <div class="st">使用 WorkBuddy 登录</div>
            <div class="sd">用 WorkBuddy 账号授权，不用等短信验证码。</div>
          </div>
          <button class="btn small ghost" id="cloud-wb" type="button">去登录</button>
        </div>`
            : `<div class="sd" style="margin-top:2px;opacity:.75">当前版本请用手机号验证码登录（账号授权登录需要浏览器跳转回应用，本地版暂不支持）。</div>`
        }
      </div>`;
    }

    const u = c.user || {};
    const who = maskPhone(u.phone) || u.name || u.email || '已登录账号';
    const dot = c.status === 'error' ? 'bad' : c.status === 'syncing' ? 'busy' : 'ok';
    const line =
      c.status === 'syncing'
        ? '正在同步…'
        : c.status === 'error'
          ? c.message || '同步失败'
          : c.dirty
            ? '本机有改动，稍后自动上传'
            : c.message || '已同步';
    return `<div class="panel">${head}
      <div class="set-row">
        <div class="set-info">
          <div class="st">☁️ ${esc(who)}</div>
          <div class="sd">上次同步：${fmtTime(c.lastSyncAt)} · ${esc(line)}</div>
        </div>
        <span class="cloud-dot ${dot}"></span>
      </div>
      <div class="set-row">
        <div class="set-info"><div class="st">立即同步</div><div class="sd">把本机进度推到云端，或拉回其它设备的最新记录。</div></div>
        <button class="btn small" id="cloud-sync" type="button">同步</button>
      </div>
      <div class="set-row" style="border-bottom:0">
        <div class="set-info"><div class="st">退出登录</div><div class="sd">退出后本机数据保留，只是不再上传。</div></div>
        <button class="btn small ghost" id="cloud-out" type="button">退出</button>
      </div>
    </div>`;
  }

  /* opts: { rerender, toast, confirm } —— 由各端传自己的 UI 辅助函数 */
  function bindPanel(opts) {
    const o = opts || {};
    const c = info();
    if (!c.available) return;
    const $ = (sel) => document.querySelector(sel);
    const rerender = () => {
      if (typeof o.rerender === 'function') o.rerender();
    };
    const say = (text, bad) => {
      if (typeof o.toast === 'function') o.toast(text, '', !!bad);
    };
    const msg = $('#cloud-msg');
    const showMsg = (text, bad) => {
      if (!msg) return;
      msg.textContent = text || '';
      msg.className = 'cloud-msg' + (bad ? ' bad' : '');
    };

    if (!c.signedIn) {
      const phoneEl = $('#cloud-phone');
      if (phoneEl) phoneEl.oninput = () => showMsg('');
      const sendBtn = $('#cloud-send');
      if (sendBtn) {
        sendBtn.onclick = async () => {
          sendBtn.disabled = true;
          const r = await sendPhoneCode(phoneEl ? phoneEl.value : '');
          sendBtn.disabled = false;
          showMsg(r.ok ? '验证码已发送，输入后点登录' : r.message, !r.ok);
        };
      }
      const loginBtn = $('#cloud-login');
      if (loginBtn) {
        loginBtn.onclick = async () => {
          loginBtn.disabled = true;
          const r = await submitPhoneCode($('#cloud-code') ? $('#cloud-code').value : '');
          loginBtn.disabled = false;
          if (!r.ok) showMsg(r.message, true);
          else rerender();
        };
      }
      const wbBtn = $('#cloud-wb');
      if (wbBtn) {
        wbBtn.onclick = async () => {
          wbBtn.disabled = true;
          const r = await signInWithWorkBuddy();
          wbBtn.disabled = false;
          if (r && !r.ok) showMsg(r.message, true);
        };
      }
      return;
    }

    const syncBtn = $('#cloud-sync');
    if (syncBtn) {
      syncBtn.onclick = async () => {
        syncBtn.disabled = true;
        const r = await runSync();
        syncBtn.disabled = false;
        if (r && r.ok) say('☁️ 已同步');
        else say((r && r.message) || '同步失败，稍后会自动重试', true);
        rerender();
      };
    }
    const outBtn = $('#cloud-out');
    if (outBtn) {
      outBtn.onclick = async () => {
        let yes = true;
        if (typeof o.confirm === 'function') {
          yes = await o.confirm('退出云同步登录？', '本机数据不会被删除，只是不再上传到云端。');
        }
        if (!yes) return;
        await signOut();
        rerender();
        say('已退出登录');
      };
    }
  }

  /* 供其他模块（AI 自训练等）读写自己的云端数据表；未登录返回 null。
   * 身份与隔离由服务端 RLS 决定，前端不传 owner_id。 */
  function database() {
    try {
      if (!client || !session) return null;
      return client.database;
    } catch (e) {
      return null;
    }
  }
  function account() {
    const u = (session && session.user) || null;
    return u ? { id: String(u.id || ''), name: String(u.name || '') } : null;
  }

  return {
    start,
    info,
    onChange,
    database,
    account,
    notifyLocalChange,
    syncNow: runSync,
    sendPhoneCode,
    submitPhoneCode,
    signInWithWorkBuddy,
    signOut,
    panelHTML,
    bindPanel,
  };
})();
