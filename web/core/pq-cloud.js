/* PlanQuest 云同步模块（网页版 / PWA）
 * 1) 登录：手机验证码 + WorkBuddy 账号登录；
 * 2) 数据：每个账号一份打卡快照，存在云数据库 pq_state 表（JSONB），按 owner_id 隔离；
 * 3) 策略：本地优先。业务照旧写 localStorage，改动后防抖推云端；登录/启动时按 updated_at 拉取合并，
 *    离线或未登录时完全不影响本地使用。
 */
'use strict';

window.PQCloud = (() => {
  /* 云服务公开配置：由 WorkBuddy 云服务下发，可随前端一起发布（不含任何私钥） */
  const PUBLIC_CONFIG = {
    endpoint: 'https://planquest-pwa.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_PFmOcAFXeaCjcrwX348z9K_GzL2rQYXrxw0yfIor7CN7boW74hreqVT',
  };

  const TABLE = 'pq_state';
  const META_KEY = 'pq-cloud-meta-v1';
  const INIT_PROFILE_POINTS = 100; // 新用户初始积分（与 core 默认数据保持一致）
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
  const PUSH_DELAY = 1500;

  let client = null;
  let sdkMissing = '';
  let session = null;
  let pendingOtp = null;
  let status = 'local'; // local | syncing | synced | error
  let message = '未登录';
  let lastSyncAt = 0;
  let dirty = false;
  let applying = false;
  let busy = false;
  let pushTimer = null;
  let started = false;
  let conflictResolver = null;
  let appliedHook = null;
  const listeners = [];

  /* ---------- 元信息（只存上次同步时间与账号标识，不含 token） ---------- */
  function readMeta() {
    try {
      const raw = localStorage.getItem(META_KEY);
      const m = raw ? JSON.parse(raw) : null;
      if (m && typeof m === 'object') {
        lastSyncAt = Number(m.lastSyncAt) || 0;
      }
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

  /* ---------- 错误归类（只留人话，不打印原始对象） ---------- */
  function describeError(err) {
    if (!err) return '同步失败，请稍后重试';
    const code = err.code || err.status || '';
    const text = String(err.message || '');
    if (code === '42P01' || /relation .* does not exist/i.test(text)) return '云端数据表尚未就绪';
    if (code === '42501' || /row-level security|permission denied/i.test(text)) return '数据不属于当前账号，已拒绝访问';
    if (code === 401 || /unauthor|token|session/i.test(text)) return '登录已过期，请重新登录';
    if (/network|failed to fetch|timeout|offline/i.test(text)) return '网络不通，稍后会自动重试';
    return text || '同步失败，请稍后重试';
  }
  function fail(err) {
    const m = describeError(err);
    setStatus('error', m);
    return { ok: false, message: m };
  }

  /* ---------- 数据库读写（身份由云端按登录态自动判定，前端不传 owner_id） ---------- */
  async function dbFetch() {
    const { data: row, error } = await client.database
      .from(TABLE)
      .select('id,state,rev,updated_at')
      .maybeSingle();
    if (error) throw error;
    return row || null;
  }

  async function dbPush() {
    const ownerName = (session && session.user && session.user.name) || null;
    const existing = await dbFetch();
    if (existing) {
      const { data: rows, error } = await client.database
        .from(TABLE)
        .update({ state: data, owner_name: ownerName })
        .eq('id', existing.id)
        .select('rev,updated_at');
      if (error) throw error;
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('云端拒绝了这次写入（数据不属于当前账号）');
      return rows[0];
    }
    const { data: rows, error } = await client.database
      .from(TABLE)
      .insert({ state: data, owner_name: ownerName })
      .select('rev,updated_at');
    if (error) throw error;
    return Array.isArray(rows) ? rows[0] : rows;
  }

  /* ---------- 合并策略 ---------- */
  function hasLocalData() {
    if (!data) return false;
    // 示例计划 / 仅初始积分不算「真实数据」，避免新设备首次登录就弹合并提示
    const realPlans = Array.isArray(data.plans) ? data.plans.filter((p) => p && !/^demo-/.test(String(p.id))).length : 0;
    const logs = data.log && typeof data.log === 'object' ? Object.keys(data.log).length : 0;
    const points = Number(data.profile && data.profile.points) || 0;
    return realPlans > 0 || logs > 0 || points !== INIT_PROFILE_POINTS;
  }

  function adopt(remote) {
    applying = true;
    try {
      data = normalize(remote.state && typeof remote.state === 'object' ? remote.state : {});
      saveNow(); // 落本地缓存，但不回推云端（applying 抑制）
      dirty = false;
      lastSyncAt = Date.parse(remote.updated_at) || Date.now();
      persistMeta();
      if (typeof emitState === 'function') emitState();
      if (typeof appliedHook === 'function') appliedHook();
      setStatus('synced', '已从云端恢复');
    } finally {
      applying = false;
    }
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
        if (!hasLocalData()) {
          adopt(remote);
        } else {
          let choice = 'remote';
          try {
            if (typeof conflictResolver === 'function') choice = await conflictResolver();
          } catch (e) {
            choice = 'remote';
          }
          if (choice === 'local') await push();
          else adopt(remote);
        }
        return { ok: true };
      }
      if (remoteAt > lastSyncAt) {
        adopt(remote);
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

  /* ---------- 供 pq-core 调用：本地数据变了 ---------- */
  function notifyLocalChange() {
    if (applying) return;
    dirty = true;
    if (!session) {
      if (status !== 'local') setStatus('local', '未登录');
      return;
    }
    schedulePush();
  }

  /* ---------- 登录流程 ---------- */
  async function handleCallback() {
    const url = new URL(location.href);
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) return { handled: false };
    const provider = url.searchParams.get('provider');
    if (provider !== 'workbuddy') {
      // 只开通了 WorkBuddy 账号登录，其它来源的回调视为无效
      ['code', 'state', 'provider', 'error', 'error_description'].forEach((k) => url.searchParams.delete(k));
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      return { handled: true, error: '授权回调缺少有效的登录方式，请重新登录' };
    }
    const handler = client.auth.handleWorkBuddyCallback;
    if (typeof handler !== 'function') return { handled: true, error: '当前云服务组件不支持该登录方式，请刷新页面重试' };
    const { data: s, error } = await handler.call(client.auth);
    if (error) {
      return { handled: true, error: error.message || '登录失败，请重试' };
    }
    if (s) {
      ['code', 'state', 'provider'].forEach((k) => url.searchParams.delete(k));
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      setSession(s);
      return { handled: true };
    }
    return { handled: true };
  }

  function setSession(s) {
    session = s || null;
    if (session) persistMeta();
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
      pendingOtp = {
        phone: value,
        verificationId: sent.data.verificationId,
        isExistingUser: sent.data.isExistingUser,
      };
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
      setSession(res.data && res.data.session ? res.data.session : res.data);
      await afterSignIn();
      return { ok: true };
    } catch (e) {
      return { ok: false, message: describeError(e) };
    }
  }

  function signInWithWorkBuddy() {
    if (!client) return { ok: false, message: sdkMissing || '云服务暂不可用' };
    const back = new URL(location.href);
    back.pathname = '/';
    ['code', 'state', 'provider'].forEach((k) => back.searchParams.delete(k));
    return client.auth
      .signInWithOAuth({ provider: 'workbuddy', redirectTo: back.toString() })
      .then(({ data: d, error }) => {
        if (error) return { ok: false, message: error.message || '暂时无法使用该方式登录' };
        location.assign(d.url); // 同一个标签页跳转，PKCE 凭据才不会丢
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
  // 云端 SDK 优先用随站点内置的副本（离线 / 国内网络也能用），加载失败才回落到 CDN
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
      sdkMissing = '云端组件没加载成功（离线或网络受限），本地功能不受影响';
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
      sdkMissing = '云端组件初始化失败，本地功能不受影响';
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
    started = true;
    if (opts) {
      if (typeof opts.onConflict === 'function') conflictResolver = opts.onConflict;
      if (typeof opts.onApplied === 'function') appliedHook = opts.onApplied;
      if (typeof opts.onChange === 'function') onChange(opts.onChange);
    }

    readMeta();
    setStatus('local', '正在连接云端…');

    boot();

    // 断网恢复后自动补推
    window.addEventListener('online', () => {
      if (session && dirty) runSync();
    });
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
    database,
    account,
    info,
    onChange,
    notifyLocalChange,
    syncNow: runSync,
    sendPhoneCode,
    submitPhoneCode,
    signInWithWorkBuddy,
    signOut,
  };
})();
