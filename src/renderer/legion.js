/* PlanQuest · 军团（局域网批量同步）
 *
 * 用的是和自习房一样的技术：裸 TCP + JSON 行协议，房主开服务、成员连进去。
 * 区别只在节奏：房间是秒级的实时互动，军团是「每过几个小时」上报考勤摘要。
 *
 * 三条硬规则，写死在代码里：
 *   1. 没加入军团 → 不起定时器、不连 socket、队列里一个包都不发；
 *   2. 只发档位，不发原始数据 —— 计划名、押金金额、备注、积分绝对值都不在这份摘要里，
 *      主进程还会再裁一次白名单，前端被改也传不出去；
 *   3. 聚合出来的只有「大约几成人」「谁还差一点」这种说法，不编造精确百分比。
 *
 * 集体挑战只奖不罚：这周没凑够，就是没有徽记，不扣分、不降级、不通报。
 */
'use strict';

window.PQLegion = (function () {
  const KEY = 'pq-legion-v1';
  const HOUR = 3600e3;
  const TICK = 60e3;

  const DEF = {
    joined: false,
    role: 'none', // host | member
    net: 'lan', // lan（同一个 WiFi，走 TCP） | p2p（异地，走 WebRTC 点对点）
    code: '',
    alias: '',
    uid: '',
    ip: '',
    port: 48770,
    intervalH: 4,
    lastSyncAt: 0,
    lastAckAt: 0,
    paused: false,
    createdAt: 0,
    agg: null, // 最近一次收到的军团概况（离线也能看）
    online: false,
    err: '',
    pendingJoin: false, // 异地成员：已生成回执码，等房主粘贴后连上
    mutedLocal: false, // 本机熔断：关掉自动化挑战奖励
    you: '', // 个人位置：只回给本人（top/upper/mid/lower/only），不公开他人
  };

  let st = { ...DEF };
  let getState = null;
  let timer = null;
  let busy = false;
  let started = false;
  const listeners = [];

  /* ---------- 平台能力 ---------- */

  function hasApi() {
    return !!(window.api && typeof window.api.legionCreate === 'function');
  }

  /* 异地：WebRTC 点对点（与自习房「异地联机」同一套技术） */
  function p2p() {
    return window.PQLegionNet || null;
  }

  function hasP2P() {
    return !!(p2p() && p2p().ready());
  }

  /* ---------- 存取 ---------- */

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return;
      st = { ...DEF, ...o };
      st.agg = o.agg || null;
      st.online = false; // 进程重启后连接肯定没了，等握手
      st.err = '';
    } catch (_) {}
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(st));
    } catch (_) {}
  }

  /* ---------- .pqplan 军团元数据：换设备接着打 ----------
   * 只带身份字段（军团码/代号/uid/连接参数/节奏），绝不带打卡明细与聚合概况。
   * 异地连接的配对是一次性的，换设备后仍需重新配对一次。 */
  const META_KEYS = ['joined', 'role', 'net', 'code', 'alias', 'uid', 'ip', 'port', 'intervalH', 'createdAt', 'paused', 'mutedLocal'];
  function exportMeta() {
    if (!st.joined) return null;
    const out = {};
    for (const k of META_KEYS) if (st[k] !== undefined) out[k] = st[k];
    return out;
  }
  function importMeta(meta) {
    if (!meta || typeof meta !== 'object') return false;
    for (const k of META_KEYS) if (meta[k] !== undefined) st[k] = meta[k];
    st.online = false; // 重启后连接都没了，等握手
    st.err = '';
    st.pendingJoin = false;
    save();
    notify();
    return true;
  }

  /* ---------- 通知 ---------- */

  function notify() {
    for (const cb of listeners) {
      try {
        cb(info());
      } catch (_) {}
    }
  }

  function onChange(cb) {
    if (typeof cb === 'function') listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /* ---------- 摘要：只生成档位 ---------- */

  function ymd(d) {
    const t = d instanceof Date ? d : new Date(d);
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const dd = String(t.getDate()).padStart(2, '0');
    return `${t.getFullYear()}-${m}-${dd}`;
  }

  /* 只有四种状态，全部是 0/1：
   *   今日已打卡 / 未打卡 / 强制模式中 / 负分挣扎中
   * 同步的只有状态，不同步明细 —— 计划内容、具体时长、积分余额、契约金额、
   * 摄像头画面，一个字段都不在这份摘要里。 */
  function build(s) {
    const out = { v: 2, day: ymd(new Date()), checked: 0, force: 0, neg: 0 };
    if (!s) return out;

    const plans = Array.isArray(s.todayPlans) ? s.todayPlans : [];
    const did = plans.some((p) => p && p.status === 'done');
    out.checked = did || s.todayBonus ? 1 : 0; // 有完成项，或今天已经签过到
    out.force = s.guard && s.guard.enabled ? 1 : 0;
    out.neg = (Number(s.profile && s.profile.points) || 0) < 0 ? 1 : 0;
    return out;
  }

  /* ---------- 连接 ---------- */

  async function ensure() {
    /* 异地模式：连接由 PQLegionNet 管，主进程只做聚合 */
    if (st.net === 'p2p') {
      const N = p2p();
      if (!N) return false;
      if (st.role === 'host') {
        const r = await N.hostStart({ code: st.code, alias: st.alias, uid: st.uid });
        if (!r || !r.ok) {
          st.err = (r && r.message) || '异地军团启动失败';
          return false;
        }
        st.code = r.code || st.code;
        st.uid = r.uid || st.uid;
        st.online = true;
        save();
        return true;
      }
      const ni = N.info();
      if (ni.role === 'member' && ni.memberOnline) {
        st.online = true;
        return true;
      }
      st.err = '异地连接已断开，需要重新配对一次';
      return false;
    }

    if (!hasApi()) return false;
    try {
      const s = await window.api.legionStatus();
      if (s && s.inLegion) {
        st.online = true;
        if (s.agg) st.agg = s.agg;
        return true;
      }
    } catch (_) {}

    if (st.role === 'host') {
      const r = await window.api.legionCreate({ code: st.code, alias: st.alias, uid: st.uid });
      if (r && r.ok) {
        st.ip = r.ip || st.ip;
        st.port = r.port || st.port;
        st.uid = r.uid || st.uid;
        st.code = r.code || st.code;
        st.online = true;
        save();
        return true;
      }
      st.err = (r && r.message) || '开服务失败';
      return false;
    }

    const r = await window.api.legionJoin({
      ip: st.ip,
      port: st.port,
      code: st.code,
      alias: st.alias,
      uid: st.uid,
      intervalH: st.intervalH,
    });
    if (r && r.ok) {
      st.uid = r.uid || st.uid;
      st.online = true;
      if (r.agg) st.agg = r.agg;
      save();
      return true;
    }
    st.err = (r && r.message) || '连不上房主';
    return false;
  }

  /* ---------- 同步 ---------- */

  function due() {
    if (!st.joined || st.paused) return false;
    return Date.now() - (st.lastSyncAt || 0) >= (st.intervalH || 4) * HOUR;
  }

  async function syncNow(opts) {
    const force = !!(opts && opts.force);
    if (!st.joined) return { ok: false, message: '未加入军团，不会同步任何数据' };
    if (st.paused && !force) return { ok: false, message: '同步已暂停' };
    const p2pMode = st.net === 'p2p';
    if (!p2pMode && !hasApi()) return { ok: false, message: '这台设备没有局域网同步能力' };
    if (p2pMode && !hasP2P()) return { ok: false, message: '这台设备没有异地通道能力' };
    if (busy) return { ok: false, message: '正在同步…' };

    busy = true;
    notify();
    try {
      const ok = await ensure();
      if (!ok) {
        st.online = false;
        notify();
        return { ok: false, message: st.err || '连不上房主' };
      }
      const brief = build(getState ? getState() : null);

      let r;
      if (p2pMode) {
        const N = p2p();
        N.setIdentity(st.uid, st.alias);
        r = st.role === 'host' ? await N.pushAsHost(brief) : await N.pushAsMember(brief);
      } else {
        r = await window.api.legionPush(brief);
      }

      if (r && r.ok) {
        st.lastSyncAt = Date.now();
        st.err = '';
        save();
      } else {
        st.err = (r && r.message) || '同步失败';
      }
      return r || { ok: false, message: st.err };
    } catch (e) {
      st.err = '同步出错';
      return { ok: false, message: st.err };
    } finally {
      busy = false;
      notify();
    }
  }

  function tick() {
    /* 未加入 / 已暂停：直接返回。这是「没加入军团就不同步」的硬闸，
       定时器照常转，但不产生任何网络动作，也不攒待发队列。 */
    if (!st.joined || st.paused) return;
    if (!due()) return;
    syncNow().catch(() => {});
  }

  /* ---------- 加入 / 退出 ---------- */

  function randCode() {
    const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
    let out = '';
    for (let i = 0; i < 4; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out.toUpperCase();
  }

  function newUid() {
    return 'u-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  }

  async function create(opts) {
    const o = opts || {};
    if (st.joined) return { ok: false, message: '已经在军团里了，先退出' };
    /* L2 社交特权：自己开军团要信誉 ≥100。新号默认就是 100，
       这条只挡「被扣到 100 以下还硬要当团长」的人——先把自己那份打卡补上。 */
    const cr = Number(o.credit);
    if (Number.isFinite(cr) && cr < 100) {
      return { ok: false, message: '信誉 ' + Math.round(cr) + ' 分，暂时不能自己开军团（L2 社交特权要 ≥100 分）。先把打卡补上' };
    }
    const uid = newUid();

    /* 异地：WebRTC 点对点，房主仍要生成邀请码给别人 */
    if (o.net === 'p2p') {
      if (!hasP2P()) return { ok: false, message: '这台设备不支持异地通道，请用同一个 WiFi 模式' };
      const code = randCode();
      const N = p2p();
      N.setIdentity(uid, o.alias || '');
      const r = await N.hostStart({ code, alias: o.alias || '', uid });
      if (!r || !r.ok) return r || { ok: false, message: '创建失败' };
      st = {
        ...DEF,
        joined: true,
        role: 'host',
        net: 'p2p',
        code: r.code || code,
        alias: o.alias || '',
        uid: r.uid || uid,
        intervalH: 4,
        createdAt: Date.now(),
        online: true,
      };
      save();
      notify();
      try {
        await syncNow({ force: true });
      } catch (_) {}
      return { ok: true, code: st.code, net: 'p2p' };
    }

    if (!hasApi()) return { ok: false, message: '这台设备不能当房主，请在电脑上创建' };
    const code = randCode();
    const r = await window.api.legionCreate({ code, alias: o.alias || '', uid });
    if (!r || !r.ok) return r || { ok: false, message: '创建失败' };
    st = {
      ...DEF,
      joined: true,
      role: 'host',
      net: 'lan',
      code: r.code || code,
      alias: o.alias || '',
      uid: r.uid || uid,
      ip: r.ip || '',
      port: r.port || 48770,
      intervalH: 4,
      createdAt: Date.now(),
      online: true,
    };
    save();
    notify();
    /* 加入即报一次到：不然聚合里「军团 N 人」对不上「今天几个人动了」 */
    try {
      await syncNow({ force: true });
    } catch (_) {}
    return { ok: true, code: st.code, ip: st.ip, port: st.port, net: 'lan' };
  }

  /* 异地加入（第一步：粘贴邀请码 → 得到回执码） */
  async function joinP2P(opts) {
    const o = opts || {};
    const invite = String(o.invite || '').trim();
    if (!invite) return { ok: false, message: '请先粘贴朋友发来的邀请码' };
    /* 异地连接在关软件时就没了，旧的 joined 只是残影：允许直接重新配对 */
    if (st.joined || st.pendingJoin) {
      if (st.net === 'p2p' && st.role === 'member') {
        try {
          const N0 = p2p();
          if (N0) N0.leave();
        } catch (_) {}
        st = { ...DEF, intervalH: st.intervalH };
        save();
      } else {
        return { ok: false, message: '已经在军团里了，先退出' };
      }
    }
    if (!hasP2P()) return { ok: false, message: '这台设备不支持异地通道' };

    const uid = newUid();
    const N = p2p();
    N.setIdentity(uid, o.alias || '');
    const r = await N.accept(invite);
    if (!r || !r.ok) return r || { ok: false, message: '邀请码无法使用' };

    st = {
      ...DEF,
      joined: false,
      pendingJoin: true,
      role: 'member',
      net: 'p2p',
      code: r.code || '',
      alias: o.alias || '',
      uid,
      intervalH: 4,
      createdAt: Date.now(),
    };
    save();
    notify();

    /* 回执码发出后，等对方粘贴 —— 连上就自动转正 */
    N.waitOnline(180000)
      .then(async (online) => {
        if (!online) {
          st.pendingJoin = false;
          st.err = '还没连上：把回执码发给房主，等他粘贴后会自动连上；也可以重新配对';
          save();
          notify();
          return;
        }
        st.pendingJoin = false;
        st.joined = true;
        st.online = true;
        st.err = '';
        save();
        notify();
        try {
          await syncNow({ force: true });
        } catch (_) {}
      })
      .catch(() => {});

    return { ok: true, text: r.text, code: r.code, waiting: true };
  }

  async function join(opts) {
    if (!hasApi()) return { ok: false, message: '这台设备暂无局域网同步能力' };
    const o = opts || {};
    const ip = String(o.ip || '').trim();
    const code = String(o.code || '').trim().toUpperCase();
    if (!ip) return { ok: false, message: '请填房主的局域网 IP' };
    if (!code) return { ok: false, message: '请填军团码' };
    if (st.joined) return { ok: false, message: '已经在军团里了，先退出' };
    const uid = newUid();
    const r = await window.api.legionJoin({
      ip,
      port: Number(o.port) || 48770,
      code,
      alias: o.alias || '',
      uid,
      intervalH: Number(o.intervalH) || 4,
    });
    if (!r || !r.ok) return r || { ok: false, message: '加入失败' };
    st = {
      ...DEF,
      joined: true,
      role: 'member',
      code: r.code || code,
      alias: o.alias || '',
      uid: r.uid || uid,
      ip,
      port: Number(o.port) || 48770,
      intervalH: Number(o.intervalH) || 4,
      createdAt: Date.now(),
      online: true,
      agg: r.agg || null,
    };
    save();
    notify();
    try {
      await syncNow({ force: true });
    } catch (_) {}
    return { ok: true, code: st.code };
  }

  function leave() {
    try {
      if (st.net === 'p2p') {
        const N = p2p();
        if (N) N.leave();
      }
    } catch (_) {}
    try {
      if (window.api && typeof window.api.legionLeave === 'function') window.api.legionLeave();
    } catch (_) {}
    const keepInterval = st.intervalH;
    st = { ...DEF, intervalH: keepInterval };
    save();
    notify();
    return { ok: true };
  }

  function setIntervalH(h) {
    const n = Math.max(1, Math.min(24, Number(h) || 4));
    st.intervalH = n;
    save();
    notify();
    return n;
  }

  function setPaused(b) {
    st.paused = !!b;
    save();
    notify();
    return st.paused;
  }

  /* 翻车救援：点一盏灯。只让军团的「救援值」+1，不记谁点的、点给谁 */
  async function lamp() {
    if (!st.joined) return { ok: false, message: '未加入军团' };
    try {
      /* 扣分与每日限额都由本机主进程管，异地也是一样：先记账，再通知房主 */
      const r = await window.api.legionLamp();
      if (!r || !r.ok) return r || { ok: false, message: '点灯失败' };
      if (st.net === 'p2p' && st.role === 'member') {
        const N = p2p();
        if (N && N.lampToHost) N.lampToHost();
      }
      return r;
    } catch (_) {
      return { ok: false, message: '点灯失败' };
    }
  }

  /* 熔断开关：关掉自动化的集体挑战与徽章发放，不解散、不惩罚 */
  async function setMuted(b) {
    try {
      if (hasApi() && typeof window.api.legionMute === 'function') await window.api.legionMute(!!b);
    } catch (_) {}
    st.mutedLocal = !!b;
    save();
    notify();
    return st.mutedLocal;
  }

  /* 负分者领一盏灯：从军团救援池里取，每天 1 次 */
  async function claimLamp() {
    if (!st.joined) return { ok: false, message: '未加入军团' };
    try {
      if (!hasApi() || typeof window.api.legionClaimLamp !== 'function') {
        return { ok: false, message: '这台设备不能领灯' };
      }
      const r = await window.api.legionClaimLamp();
      return r || { ok: false, message: '领不到' };
    } catch (_) {
      return { ok: false, message: '领不到' };
    }
  }

  /* 集体挑战达标：向主进程领一枚徽章（次日打卡双倍），熔断时不发 */
  function maybeBadge(agg) {
    if (!agg || !agg.challenge || !agg.challenge.reached) return;
    if (mutedNow()) return;
    try {
      if (hasApi() && typeof window.api.legionBadge === 'function') {
        window.api.legionBadge(agg.challenge.key).catch(() => {});
      }
    } catch (_) {}
  }

  function mutedNow() {
    return !!(st.mutedLocal || (st.agg && st.agg.muted));
  }

  /* ---------- 主进程事件 ---------- */

  function onEvent(evt) {
    if (!evt || !st.joined) return; // 未加入时任何事件都不该改变本地状态
    if (evt.type === 'agg' && evt.agg) {
      st.agg = evt.agg;
      st.online = true;
      save();
      notify();
    } else if (evt.type === 'ack') {
      st.lastAckAt = Number(evt.at) || Date.now();
      st.online = true;
      save();
      notify();
    } else if (evt.type === 'offline') {
      st.online = false;
      notify();
    } else if (evt.type === 'you' && evt.pos) {
      st.you = String(evt.pos);
      save();
      notify();
    } else if (evt.type === 'agg' && evt.agg) {
      maybeBadge(evt.agg);
    } else if (evt.type === 'status') {
      st.online = !!evt.inLegion;
      notify();
    }
  }

  /* ---------- 启动 ---------- */

  function start(opts) {
    load();
    if (opts && typeof opts.getState === 'function') getState = opts.getState;
    if (started) return;
    started = true;
    if (hasApi() && typeof window.api.onLegion === 'function') window.api.onLegion(onEvent);

    /* 异地：WebRTC 侧的事件同样落到同一套状态上 */
    const N = p2p();
    if (N) {
      N.onAggregate((agg) => {
        if (!st.joined || !agg) return;
        maybeBadge(agg);
        st.agg = agg;
        st.online = true;
        st.err = '';
        save();
        notify();
      });
      N.on((evt) => {
        if (!st.joined || !evt) return;
        if (evt.type === 'offline') {
          st.online = false;
          st.err = evt.reason || '异地连接已断开';
          notify();
        } else if (evt.type === 'online') {
          st.online = true;
          st.err = '';
          notify();
        } else if (evt.type === 'agg' && evt.agg) {
          st.agg = evt.agg;
          save();
          notify();
        } else if (evt.type === 'you' && evt.pos) {
          st.you = String(evt.pos);
          save();
          notify();
        }
      });
    }

    if (timer) clearInterval(timer);
    timer = setInterval(tick, TICK);
    /* 开机补一次：关机期间攒下的那次同步，开机后几秒内补上 */
    if (st.joined && !st.paused) setTimeout(() => { if (due()) syncNow().catch(() => {}); }, 8000);
  }

  /* ---------- 给 UI 的快照 ---------- */

  function info() {
    const now = Date.now();
    const nextAt = st.joined ? (st.lastSyncAt || 0) + (st.intervalH || 4) * HOUR : 0;
    return {
      available: hasApi(),
      joined: !!st.joined,
      pendingJoin: !!st.pendingJoin,
      role: st.role,
      net: st.net,
      p2p: hasP2P(),
      muted: mutedNow(),
      you: st.you || '',
      heat: heatOf(st.agg),
      code: st.code,
      alias: st.alias,
      uid: st.uid,
      ip: st.ip,
      port: st.port,
      intervalH: st.intervalH,
      paused: !!st.paused,
      online: !!st.online,
      busy,
      lastSyncAt: st.lastSyncAt || 0,
      lastAckAt: st.lastAckAt || 0,
      nextAt,
      leftMs: nextAt ? Math.max(0, nextAt - now) : 0,
      err: st.err || '',
      agg: st.agg || null,
      createdAt: st.createdAt || 0,
    };
  }

  /* 模糊措辞：只给档位与措辞，不出现百分比、不点名 */
  function moodText(agg) {
    if (!agg || !agg.n) return '军团还没聚起来。';
    switch (agg.mood) {
      case 'hot':
        return '今天全员到齐，军团一条心。';
      case 'warm':
        return '今天过半的人打了卡，节奏稳。';
      case 'cold':
        return '今天零星几个人动了，不用急。';
      case 'flat':
        return '今天都还没动，不必等别人先动。';
      default:
        return '今天还没收到大家的消息。';
    }
  }

  /* 纪律值（士气）：出操率、连击周、救援值 —— 全团共享，绝不指向任何个人 */
  function moraleText(agg) {
    if (!agg || !agg.n) return '';
    const rateTxt = ['今天没人打卡', '今天零星有人打卡', '今天过半的人打卡', '今天全员打卡'][agg.rate || 0];
    const streak = Number(agg.streakWeeks) || 0;
    const rescue = Number(agg.rescue) || 0;
    const parts = [rateTxt];
    if (streak > 0) parts.push(`已连续 ${streak} 周达标`);
    if (rescue > 0) parts.push(`救援值 ${rescue}`);
    return parts.join(' · ') + '。';
  }

  function weekText(agg) {
    const c = agg && agg.challenge;
    if (!c || !c.target) return '这周的目标还要等成员多起来才成立。';
    if (c.reached) return '这周全团目标已经达成 —— 只加不解，接下来做什么都是净赚。';
    return '这周还差一点。差这点不扣分、不通报，慢慢补就行。';
  }

  /* 军团热度 0–100：出勤 + 连击 + 救援，三项都只看聚合值 */
  function heatOf(agg) {
    if (!agg || !agg.n) return 0;
    const rate = Number(agg.rate) || 0;
    const streak = Math.min(4, Number(agg.streakWeeks) || 0);
    const rescue = Math.min(20, Number(agg.rescue) || 0);
    return Math.min(100, Math.round(rate * 20 + streak * 8 + rescue * 1.5));
  }

  /* 需要被关心的模糊人数：只给数量，不给名单 */
  function needCare(agg) {
    if (!agg || !agg.today) return 0;
    return Math.max(0, Number(agg.today.unchecked) || 0);
  }

  return {
    start,
    create,
    join,
    joinP2P,
    leave,
    syncNow,
    setIntervalH,
    setPaused,
    lamp,
    claimLamp,
    setMuted,
    heatOf,
    mutedNow,
    onChange,
    info,
    build,
    moodText,
    moraleText,
    weekText,
    needCare,
    due,
    exportMeta,
    importMeta,
  };
})();
