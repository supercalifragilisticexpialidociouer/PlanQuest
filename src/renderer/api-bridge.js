/* PlanQuest 手机版 API 桥
 * 提供与桌面版 preload 完全相同签名的 window.api。
 * 纯逻辑 → pq-core；系统能力 → Capacitor 原生插件（window.NativeGuard）；
 * 桌面专属（局域网房间/异地联机/屏幕共享/窗口控制）→ 优雅降级提示。
 */
'use strict';

/* 军团桥接（手机版只能当成员：开服务要监听端口，WebView 做不到）
 * 复用自习房的 LanRoom 原生插件，只是把协议换成了 logger 的批量上报。 */
let lgPlugin = null;
let lgBound = false;
let lgCbs = [];
let lgPending = null;
let lgState = { inLegion: false, role: 'member', code: '', ip: '', port: 48770, uid: '', agg: null };

function lgGetPlugin() {
  if (lgPlugin) return lgPlugin;
  try {
    if (window.Capacitor && typeof window.Capacitor.registerPlugin === 'function') {
      lgPlugin = window.Capacitor.registerPlugin('LanRoom');
    }
  } catch (e) {
    lgPlugin = null;
  }
  return lgPlugin;
}

function lgEmit(evt) {
  lgCbs.forEach((cb) => {
    try {
      cb(evt);
    } catch (e) {}
  });
}

function lgBind(p) {
  if (lgBound || !p || typeof p.addListener !== 'function') return;
  lgBound = true;
  p.addListener('line', (ev) => {
    let msg = null;
    try {
      msg = JSON.parse((ev && ev.line) || '');
    } catch (e) {
      return;
    }
    if (!msg) return;
    if (msg.t === 'welcome') {
      lgState.inLegion = true;
      lgState.code = msg.code || lgState.code;
      lgState.uid = msg.myUid || lgState.uid;
      if (msg.agg) lgState.agg = msg.agg;
      if (lgPending) {
        const fn = lgPending;
        lgPending = null;
        fn({ ok: true, code: lgState.code, uid: lgState.uid, agg: lgState.agg });
      }
      if (msg.agg) lgEmit({ type: 'agg', agg: msg.agg });
    } else if (msg.t === 'agg') {
      lgState.agg = msg.agg || null;
      lgEmit({ type: 'agg', agg: lgState.agg });
    } else if (msg.t === 'ack') {
      lgEmit({ type: 'ack', at: msg.at });
    } else if (msg.t === 'error') {
      if (lgPending) {
        const fn = lgPending;
        lgPending = null;
        fn({ ok: false, message: msg.message || '房主拒绝了' });
      }
    }
  });
  p.addListener('closed', () => {
    lgState.inLegion = false;
    if (lgPending) {
      const fn = lgPending;
      lgPending = null;
      fn({ ok: false, message: '连接被断开' });
    }
    lgEmit({ type: 'offline' });
  });
}

window.api = (() => {
  const stub = (msg) => async () => ({ ok: false, message: msg || '该功能需要在电脑版使用' });
  const DESKTOP_ONLY = '📱 手机版暂未开通此功能：请在电脑上使用（房间/联机功能后续迭代）';

  /* .pqplan 覆盖留痕：旧计划不真删，AES-256-GCM 加密后藏进 localStorage。
   * 密钥单独存 pq-overwrite-vkey-v1，data 里只留索引，导出的文件看不到明文。 */
  const VAULT_KEY = 'pq-overwrite-vkey-v1';
  const VAULT_STORE = 'pq-overwrite-vault-v1';
  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fillRandom(u8) {
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(u8);
    else for (let i = 0; i < u8.length; i++) u8[i] = Math.floor(Math.random() * 256);
    return u8;
  }
  async function webVaultKey() {
    let hex = null;
    try { hex = localStorage.getItem(VAULT_KEY); } catch (_) {}
    if (hex && /^[0-9a-f]{64}$/i.test(hex)) return hex;
    const arr = fillRandom(new Uint8Array(32));
    hex = Array.from(arr, (x) => ('0' + x.toString(16)).slice(-2)).join('');
    try { localStorage.setItem(VAULT_KEY, hex); } catch (_) {}
    return hex;
  }
  async function sealWebVault(payload) {
    const PO = window.PQPlanOverwrite;
    const hex = await webVaultKey();
    const keyBytes = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
    const iv = fillRandom(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(payload));
    let blob = null, tag = new Uint8Array(0), alg = 'xor-stream';
    if (window.crypto && window.crypto.subtle) {
      try {
        const key = await window.crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
        const buf = new Uint8Array(await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
        tag = buf.slice(buf.length - 16);
        blob = buf.slice(0, buf.length - 16);
        alg = 'aes-256-gcm';
      } catch (_) { blob = null; }
    }
    if (!blob) {
      blob = new Uint8Array(plain.length);
      for (let i = 0; i < plain.length; i++) blob[i] = plain[i] ^ keyBytes[i % 32] ^ ((i * 31) & 0xff);
    }
    let sum = '';
    try { sum = (await sha256Hex(JSON.stringify(payload))) || ''; } catch (_) {}
    let store = { v: 1, entries: [] };
    try {
      const old = JSON.parse(localStorage.getItem(VAULT_STORE) || 'null');
      if (old && Array.isArray(old.entries)) store = old;
    } catch (_) {}
    store.entries.push({
      at: payload.at, scope: payload.scope, n: payload.plans.length,
      cipher: { alg, iv: b64(iv), tag: b64(tag), blob: b64(blob) },
    });
    store.entries = store.entries.slice(-(PO ? PO.RULES.VAULT_KEEP : 20));
    try { localStorage.setItem(VAULT_STORE, JSON.stringify(store)); } catch (_) {}
    return PO ? PO.vaultIndex(payload, sum) : { at: payload.at, n: payload.plans.length, sha256: sum };
  }

  const refresh = () => { try { emitState(); } catch (e) {} };

  return {
    /* 状态 */
    getState: async () => {
      const s = await snapshot();
      /* 安卓原生层的开机自启真实状态（桌面版由 preload 提供 autoStartReal） */
      try {
        if (window.NativeGuard && typeof window.NativeGuard.autoStartOn === 'function') {
          s.autoStartReal = !!(await window.NativeGuard.autoStartOn());
        }
      } catch (e) {}
      return s;
    },
    onState: (cb) => onState(cb),
    onToast: (cb) => onToast(cb),
    onReminder: (cb) => cb,           // 手机版提醒走系统通知，无需窗口
    onRoom: () => () => {},
    onUnlisted: (cb) => {
      // 原生守护检测到名单外 App 时会回调
      if (window.NativeGuard && window.NativeGuard.onUnlisted) window.NativeGuard.onUnlisted(cb);
      return () => {};
    },

    /* 计划与打卡 */
    savePlan: async (p) => {
      /* 桌面版签名叫 api.savePlan({plan, password})，这里统一拆开喂给 pq-core */
      const plan = p && p.plan ? { ...p.plan, ...(p.password ? { password: p.password } : {}) } : p;
      const r = savePlan(plan);
      refresh();
      return r;
    },
    deletePlan: async (p) => {
      const r = typeof p === 'string' ? deletePlan(p) : deletePlan(p?.id, p?.password);
      refresh();
      if (r.needPassword) return r;
      return r;
    },
    togglePlan: async (a, b) => {
      /* 桌面包是 (id, enabled)，手机版内部按对象走 —— 两种都收 */
      const id = a && typeof a === 'object' ? a.id : a;
      const enabled = a && typeof a === 'object' ? a.enabled : b;
      const r = togglePlan(id, enabled);
      refresh();
      return r;
    },
    checkin: async (id, password) => { const r = doCheckin(id, dateKey(), password); refresh(); return r; },
    undoCheckin: async (id) => { const r = undoCheckin(id); refresh(); return r; },
    makeupAdd: async (p) => { const r = makeupAdd(p); refresh(); return r; },
    testReminder: stub('手机版暂不支持手动测试弹窗'),

    /* 设置与资料 */
    updateSettings: async (patch) => {
      const p = { ...(patch || {}) };
      if ('eyeCare' in p || 'eyeCarePlan' in p) return { ok: false, needPassword: true }; // 与桌面版一致：护眼开关/节奏必须走密码通道
      for (const k of ['autoStart', 'closeToTray', 'sound', 'theme', 'snoozeMinutes', 'repeatRemind', 'netMode']) {
        if (k in p) data.settings[k] = p[k];
      }
      if ('guideDone' in p) data.settings.guideDone = !!p.guideDone;
      /* 异地通道中继配置：只接受合法结构（urls 非空），与桌面版 settings:update 的清洗一致 */
      if ('netTurn' in p) {
        const t = p.netTurn;
        data.settings.netTurn =
          t && t.urls && String(t.urls).trim()
            ? { urls: String(t.urls).trim().slice(0, 500), username: String(t.username || '').slice(0, 100), credential: String(t.credential || '').slice(0, 100) }
            : null;
      }
      if ('netMode' in p && p.netMode !== 'relay') data.settings.netMode = 'direct';
      /* 开机自启：真正落到安卓原生层（BOOT_COMPLETED 拉起提醒服务） */
      if ('autoStart' in p && window.NativeGuard && typeof window.NativeGuard.setAutoStart === 'function') {
        try { await window.NativeGuard.setAutoStart(!!p.autoStart); } catch (e) {}
      }
      saveNow(); refresh();
      return { ok: true, settings: { ...data.settings } };
    },
    profileUpdate: async (patch) => {
      for (const k of ['name', 'avatar']) if (patch && k in patch) data.profile[k] = String(patch[k]).slice(0, 12);
      saveNow(); refresh();
      return { ok: true };
    },

    /* 守护 */
    guardInfo: async () => guardian.publicInfo(),
    guardSetup: (info) => guardSetup(info || {}),
    guardSetLists: (p) => guardSetLists(p || {}),
    guardToggle: (p) => guardToggle(p || {}),
    guardProcesses: () => guardProcesses(),
    guardAdminRestart: async () => ({ ok: true, alreadyAdmin: true }),
    guardRedeemGray: (p) => guardRedeemGray(p || {}),

    /* 积分商城 */
    shopInit: async () => { ensureShopDefaults(); return { ok: true }; },
    shopAddItem: async (item) => { const r = shopAddItem(item); refresh(); return r; },
    shopDeleteItem: async (payload) => { const r = shopDeleteItem(payload); refresh(); return r; },
    shopRedeem: async (id) => { const r = shopRedeem(id); refresh(); return r; },
    shopRescueStart: async () => { const r = shopRescueStart(); refresh(); return r; },
    microComplete: async (step) => { const r = microComplete(step); refresh(); return r; },
    creditBorrow: async (n) => { const r = creditBorrow(n); refresh(); return r; },
    creditState: async () => creditState(),
    creditPenalize: async ({ amount, note } = {}) => { const r = creditPenalize(amount, note); refresh(); return r; },
    creditEvent: async ({ type, note } = {}) => { const r = creditEvent(type, note); refresh(); return r; },

    /* 军团纪律（规则与桌面端同源：web/legion-discipline.js） */
    discState: async () => disciplineState(),
    discSession: async (s) => { const r = disciplineSession(s || {}); refresh(); return r; },
    discContractNew: async (p) => { const r = discContractNew(p || {}); refresh(); return r; },
    discContractSettle: async (p) => { const r = discContractSettle(p || {}); refresh(); return r; },
    discScan: async () => discScan(),
    discReview: async (p) => { const r = discReview(p || {}); refresh(); return r; },
    discThaw: async () => { const r = discThaw(); refresh(); return r; },
    pkToken: async () => ({
      ok: false,
      source: 'none',
      masked: '',
      hint: '手机版不做 PK 布告栏；电脑上配置后 token 会自动读取本机 gh / git 凭据。',
    }),
    pkTokenRefresh: async () => ({
      ok: false,
      source: 'none',
      masked: '',
      hint: '手机版不做 PK 布告栏；请在电脑上完成 GitHub 授权。',
    }),
    pkOauthStart: async () => ({ ok: false, status: 'unsupported', message: '手机版不做 PK 布告栏，请在电脑上登录 GitHub' }),
    pkOauthPoll: async () => ({ status: 'unsupported', message: '手机版不支持该操作' }),
    pkOauthCancel: async () => ({ ok: true }),
    pkOauthLogout: async () => ({ ok: true }),
    openExternal: async (url) => {
      try {
        window.open(url, '_blank', 'noopener');
        return { ok: true };
      } catch (e) {
        return { ok: false };
      }
    },
    witnessSet: async (p) => { const r = witnessSet(p); refresh(); return r; },

    /* 三件事 / 番茄钟 */
    mitAdd: async (t) => { const r = mitAdd(t); refresh(); return r; },
    mitToggle: async (id) => { const r = mitToggle(id); refresh(); return r; },
    mitDelete: async (id) => { const r = mitDelete(id); refresh(); return r; },
    focusComplete: async (p) => { const r = focusComplete(p || {}); refresh(); return r; },
    focusToggle: async () => ({ ok: true, focusMode: false }), // 桌面图标隐藏为桌面专属

    /* 目标 / 契约 */
    goalAdd: async (g) => { const r = goalAdd(g); refresh(); return r; },
    goalDelete: async (id) => { const r = goalDelete(id); refresh(); return r; },
    goalAddMilestone: async (p) => { const r = goalAddMilestone(p); refresh(); return r; },
    goalDeleteMilestone: async (p) => { const r = goalDeleteMilestone(p); refresh(); return r; },
    goalToggleMilestone: async (p) => { const r = goalToggleMilestone(p); refresh(); return r; },
    contractAdd: async (c) => { const r = contractAdd(c); refresh(); return r; },
    contractCheckin: async (id) => { const r = contractCheckin(id); refresh(); return r; },
    contractPay: async (p) => { const r = contractPay(p || {}); refresh(); return r; },
    contractDelete: async (id) => { const r = contractDelete(id); refresh(); return r; },
    contractProjectAdd: async (p) => { const r = contractProjectAdd(p); refresh(); return r; },
    contractProjectDelete: async (id) => { const r = contractProjectDelete(id); refresh(); return r; },
    contractProjectPay: async (p) => { const r = contractProjectPay(p || {}); refresh(); return r; },

    /* 小结 / 复盘 */
    diarySave: async (p) => { const r = diarySave(p || {}); refresh(); return r; },
    reviewSetItems: async (p) => { const r = reviewSetItems(p || {}); refresh(); return r; },

    /* 护眼模式（原生悬浮窗实现） */
    eyeCareToggle: (p) => eyeCareToggle(p || {}),
    eyeCarePlan: (p) => eyeCareSetPlan(p || {}),
    eyeCareSkip: (p) => eyeCareSkip(p || {}),
    eyeCareDone: async () => { if (window.NativeGuard) await window.NativeGuard.eyeCareDone(); return { ok: true }; },
    eyeCareInfo: async () => {
      if (window.NativeGuard) { try { return await window.NativeGuard.eyeCareInfo(); } catch (e) {} }
      return { enabled: !!data.settings.eyeCare, phase: 'idle', endsAt: 0 };
    },
    onEyeCare: (cb) => {
      if (window.NativeGuard && window.NativeGuard.onEyeCare) return window.NativeGuard.onEyeCare(cb);
      return () => {};
    },

    /* 导出 */
    exportCsv: async () => exportCsv(),
    exportData: async () => exportData(),
    exportCalendar: stub('手机版暂不支持导出日历'),
    openDataFolder: stub('手机版数据在应用本地存储，可用「导出数据」备份'),

    /* 同步码（跨设备迁移，纯本地） */
    syncCode: async () => { try { return { ok: true, code: encodeSyncCode() }; } catch (e) { return { ok: false, message: e.message }; } },
    syncImport: async (text, mode) => { const r = importData(text, mode); refresh(); return r; },

    /* 计划文件（.pqplan）：导出下载 / 文件选择导入 / 应用 */
    planfileExport: async (scope, legion) => {
      try {
        const s = ['all', 'normal', 'contract', 'meta'].includes(scope) ? scope : 'all';
        const env = await planFileEnvelope(s, legion);
        const json = JSON.stringify(env, null, 2);
        const tip = s === 'normal' ? '-普通' : s === 'contract' ? '-契约' : s === 'meta' ? '-军团元数据' : '';
        const name = 'PlanQuest计划-' + dateKey() + tip + '.pqplan';
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        return { ok: true, path: name };
      } catch (e) { return { ok: false, message: e.message }; }
    },
    /* 新建空白计划文件：网页/手机版没有「另存为」，直接下载一份空白模版 */
    planfileNew: async () => {
      try {
        const payload = defaultData();
        const env = {
          magic: 'PLANQUEST-PLAN', format: 1, app: 'PlanQuest', version: '2.7.0',
          exportedAt: new Date().toISOString(), from: 'PlanQuest 空白模版',
          checksum: await sha256Hex(JSON.stringify(payload)),
          data: payload,
        };
        const name = 'PlanQuest新计划-' + dateKey() + '.pqplan';
        const url = URL.createObjectURL(new Blob([JSON.stringify(env, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        return { ok: true, path: name };
      } catch (e) { return { ok: false, message: e.message }; }
    },
    planfilePick: () => new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.pqplan,application/json';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return resolve({ ok: false });
        try {
          const r = await parsePlanFileText(await f.text());
          resolve(r.ok ? { ...r, source: f.name } : r);
        } catch (e) { resolve({ ok: false, message: '文件读取失败：' + e.message }); }
      };
      inp.click();
    }),
    planfileApply: async ({ data: inc, mode, checksum, scope, confirmed, source }) => {
      if (checksum) {
        const sum = await sha256Hex(JSON.stringify(inc));
        if (sum && sum !== checksum) return { ok: false, message: '校验和不匹配：文件可能已损坏或被手动改动' };
      }
      const r = importDataObj(inc, mode, scope, { confirmed: !!confirmed, source: source || '' });
      /* 旧计划加密收尸：密文进 localStorage，索引写回账本 */
      if (r.ok && r.vaultPayload) {
        try {
          const idx = await sealWebVault(r.vaultPayload);
          if (typeof window.pushVaultIndex === 'function') window.pushVaultIndex(idx);
        } catch (_) {}
      }
      refresh();
      return {
        ok: r.ok, applied: r.applied, message: r.message,
        needConfirm: r.needConfirm, interrogation: r.interrogation, preview: r.preview,
        say: r.say, mood: r.mood, toast: r.toast, punish: r.punish, state: r.state,
        cover: r.cover, sin: r.sin, stats: r.stats,
      };
    },
    /* 只打开编辑：把编辑后的内容下载成 .pqplan，不应用到本机、不扣分 */
    planfileSaveEnvelope: async ({ data: payload } = {}) => {
      try {
        const env = {
          magic: 'PLANQUEST-PLAN', format: 1, app: 'PlanQuest', version: '2.7.0',
          exportedAt: new Date().toISOString(), from: 'PlanQuest 编辑',
          checksum: await sha256Hex(JSON.stringify(payload)), data: payload,
        };
        const url = URL.createObjectURL(new Blob([JSON.stringify(env, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'PlanQuest计划-编辑.pqplan';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        return { ok: true, path: a.download };
      } catch (e) { return { ok: false, message: e.message }; }
    },
    /* 启动翻旧账：读一次即销账 */
    overwriteBoot: async () => {
      try {
        return (typeof window.overwriteBoot === 'function') ? window.overwriteBoot() : { line: '', mood: '', state: null };
      } catch (_) { return { line: '', mood: '', state: null }; }
    },
    overwriteVault: async () => ({ ok: true, entries: [] }),
    /* 空白模版填充：桌面版写回原文件；网页/手机版拿不到原文件路径，改为下载空白模板 */
    planfileBlankTemplate: async () => {
      try {
        const payload = defaultData();
        const env = {
          magic: 'PLANQUEST-PLAN', format: 1, app: 'PlanQuest', version: '2.7.0',
          exportedAt: new Date().toISOString(), from: 'PlanQuest 空白模板',
          checksum: await sha256Hex(JSON.stringify(payload)),
          data: payload,
        };
        const name = 'PlanQuest空白模板.pqplan';
        const url = URL.createObjectURL(new Blob([JSON.stringify(env, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        return { ok: true, path: name };
      } catch (e) { return { ok: false, message: e.message }; }
    },

    /* 桌面专属：优雅降级 */
    roomCreate: stub(DESKTOP_ONLY),    roomProbe: stub(DESKTOP_ONLY),
    roomJoin: stub(DESKTOP_ONLY),
    roomLeave: async () => ({ ok: true }),
    roomState: async () => ({ ok: true }),
    roomReaction: async () => ({ ok: true }),
    roomChat: stub(DESKTOP_ONLY),
    roomCamFrame: async () => ({ ok: true }),
    roomShareFrame: async () => ({ ok: true }),
    roomMute: async () => ({ ok: true }),
    roomUnmute: async () => ({ ok: true }),
    roomPeers: async () => [],
    roomInvite: stub(DESKTOP_ONLY),
    roomCompanion: async () => ({ ok: false, message: DESKTOP_ONLY }),
    roomFunConfig: async () => ({ minutes: 0, points: data.profile.points || 0, enough: false, leftMin: 0, fee: 0 }),

    /* 军团：手机版只能加入，不能当房主 */
    legionCreate: async () => ({ ok: false, message: '手机版不能当房主：请在电脑上创建军团' }),
    legionJoin: async (info) => {
      const o = info || {};
      const p = lgGetPlugin();
      if (!p) return { ok: false, message: '这台设备没有局域网同步能力' };
      const host = String(o.ip || '').trim();
      if (!host) return { ok: false, message: '请填房主的局域网 IP' };
      lgBind(p);
      const op = await p.open({ host, port: Number(o.port) || 48770, timeout: 5000 });
      if (!op || !op.ok) return { ok: false, message: (op && op.message) || '连不上房主' };
      lgState.ip = host;
      lgState.port = Number(o.port) || 48770;
      const res = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          lgPending = null;
          resolve({ ok: false, message: '房主没回应（军团码可能不对）' });
        }, 6000);
        lgPending = (r) => {
          clearTimeout(timer);
          resolve(r);
        };
        p.write({
          line: JSON.stringify({
            t: 'hello',
            code: String(o.code || ''),
            alias: String(o.alias || ''),
            uid: String(o.uid || ''),
            intervalH: Number(o.intervalH) || 4,
            ver: 1,
          }),
        });
      });
      if (!res.ok) {
        try {
          await p.close();
        } catch (e) {}
      }
      return res;
    },
    legionLeave: async () => {
      const p = lgGetPlugin();
      if (p) {
        try {
          await p.write({ line: JSON.stringify({ t: 'bye' }) });
        } catch (e) {}
        try {
          await p.close();
        } catch (e) {}
      }
      lgState = { inLegion: false, role: 'member', code: '', ip: '', port: 48770, uid: '', agg: null };
      return { ok: true };
    },
    legionPush: async (bundle) => {
      const p = lgGetPlugin();
      if (!p || !lgState.inLegion) return { ok: false, message: '未连接房主' };
      try {
        await p.write({ line: JSON.stringify({ t: 'push', uid: lgState.uid, bundle: bundle || {} }) });
        return { ok: true };
      } catch (e) {
        return { ok: false, message: '发送失败' };
      }
    },
    legionStatus: async () => ({ ...lgState }),

    /* 军团治理：投票的权威结算在电脑端（谁发起、谁投票、怎么算，都写在同一份规则里）。
       手机版只做只读展示，不提供发起/投票入口，避免出现「手机投了、电脑没算」的分叉。 */
    govState: async () => {
      const G = window.PQLegionGov;
      const me = (() => {
        try {
          const d = JSON.parse(localStorage.getItem('planquest-data-v1') || '{}');
          const score = Number((d.credit || {}).score) || 0;
          return {
            uid: lgState.uid || '',
            alias: String((d.profile || {}).name || '我').slice(0, 12),
            credit: score,
            tier: G ? G.tierIndex(score) : 0,
            tierName: G ? G.tierOf(score).name : '受限',
            isHost: lgState.role === 'host',
            rosterSize: Math.max(1, Number(lgState.n) || 1),
            role: lgState.role || 'none',
            joined: !!lgState.inLegion,
          };
        } catch (e) {
          return { uid: lgState.uid || '', alias: '我', credit: 0, tier: 0, tierName: '受限', isHost: false, rosterSize: 1, role: 'none', joined: !!lgState.inLegion };
        }
      })();
      return {
        self: me,
        votes: [],
        roles: {},
        leftToday: 0,
        bannedUntil: 0,
        dailyCap: 0,
        log: [],
        smallLegion: me.rosterSize < 4,
        readonly: true,
      };
    },
    govCreate: async () => ({ ok: false, message: '发起投票要在电脑端的军团页操作' }),
    govCast: async () => ({ ok: false, message: '投票请在电脑端参与' }),
    govReport: async () => ({ ok: false, message: '举报请在电脑端操作' }),
    govAssign: async () => ({ ok: false, message: '任命职务请用电脑端' }),
    govRevoke: async () => ({ ok: false, message: '撤销职务请用电脑端' }),
    govDefs: async () => {
      const G = window.PQLegionGov;
      return G ? { tiers: G.TIERS, roles: G.ROLE_LIST, perms: G.PERMS, types: G.TYPES, limits: G.LIMITS } : null;
    },
    onLegion: (cb) => {
      if (typeof cb === 'function') lgCbs.push(cb);
      return () => {
        const i = lgCbs.indexOf(cb);
        if (i >= 0) lgCbs.splice(i, 1);
      };
    },
    // AI 盯学：摸鱼检测扣分（负数；与桌面版同一钳制规则）
    aiPenalty: async (points) => {
      const delta = Math.max(-100, Math.min(0, Math.round(Number(points) || 0)));
      setProfilePoints((data.profile.points || 0) + delta);
      saveNow();
      refresh();
      return { ok: true, points: data.profile.points || 0 };
    },
    roomOpenWindow: stub(DESKTOP_ONLY),
    netCreate: stub(DESKTOP_ONLY),
    netOpenWindow: stub(DESKTOP_ONLY),
    netCreateRoom: stub(DESKTOP_ONLY),
    netPeerId: async (p) => 'pq-' + Math.random().toString(36).slice(2, 8),
    netPack: async (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))),
    netUnpack: async (t) => JSON.parse(decodeURIComponent(escape(atob(t)))),
    screenSources: async () => [],
    screenPick: async () => ({ ok: false }),
    unlistedClose: () => {},
    unlistedKill: async () => ({ ok: true }),
    /* 版本更新只在桌面版有：网页 / 安卓优雅降级，不让按钮点了报错 */
    updateCheck: async () => ({ ok: false, reason: DESKTOP_ONLY }),
    updateDownload: async () => ({ ok: false, message: DESKTOP_ONLY }),
    updateInstall: async () => ({ ok: false, message: DESKTOP_ONLY }),
    updateComponents: async () => ({ ok: false, message: DESKTOP_ONLY }),
    /* 阿刺养成/PK 只在桌面版有（数据落本地 data.json），网页/安卓优雅降级 */
    aciState: async () => ({ ok: false, message: DESKTOP_ONLY }),
    aciAction: async () => ({ ok: false, message: DESKTOP_ONLY }),
    aciRoomSay: async () => ({ ok: false, message: DESKTOP_ONLY }),
    onUpdateStage: () => () => {},

    /* 窗口控制（手机上无意义，静默） */
    minimize: () => {},
    toggleFullscreen: async () => {
      try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch (e) {}
    },
    setFullscreen: async (on) => {
      try { if (on) await document.documentElement.requestFullscreen(); else if (document.fullscreenElement) await document.exitFullscreen(); } catch (e) {}
      return true;
    },
    hideWindow: () => {},
    closeWindow: () => {},
  };
})();
