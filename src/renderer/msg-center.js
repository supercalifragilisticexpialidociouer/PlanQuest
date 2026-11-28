/* 消息中心：微信式弹窗提醒
 *
 * 四条硬规矩（每一条都对应一个曾经踩过的坑）：
 *  1. 去重——同一条消息可能从 P2P 和 WebSocket 两条通道各来一次，指纹相同只弹一次。
 *  2. 不限频——不做「N 秒内最多 M 条」的丢弃式限流，刷屏也要全数计入，
 *     只是同一会话的泡泡原地合并成「X 条新消息」。
 *  3. 离线不逐条炸——离线堆积按会话聚合成一个泡泡，写明「N 条新消息」，且不响铃。
 *  4. 免打扰分粒度——全局开关之外，能按「这个联系人 / 这个房间 / 这个频道」单独静音；
 *     静音只代表不弹窗，未读照常累计（不静音时再补一次汇总）。
 *
 * 引擎纯逻辑（可在 node 里单测），DOM 层负责渲染，两边同文件、互不耦合。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PQMsgCenter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KINDS = {
    friend: { label: '好友私聊', icon: '💬' },
    room: { label: '自习房', icon: '🪑' },
    channel: { label: '军团频道', icon: '📣' },
    aci: { label: '阿刺', icon: '🌵' },
    system: { label: '系统', icon: '🔔' },
  };

  const DUP_TTL = 120000; // 指纹有效期：两分钟内重复的一律认为同一条
  const DUP_CAP = 800;
  const MAX_BUBBLES = 4; // 屏幕上最多同时几个泡泡，多出来的排队等位，不丢

  function keyOf(e) {
    return String((e && e.kind) || 'system') + ':' + String((e && e.convId) || 'default');
  }

  /* 指纹：有消息 id 用 id（同一条消息双通道过来必然同 id）；
     没有 id 就退化成「谁 + 说了什么」，同一人短时间内重复说同一句也算同一条。 */
  function fingerprint(e) {
    const kind = String(e.kind || 'system');
    const conv = String(e.convId || 'default');
    if (e.id) return kind + '|' + conv + '|' + String(e.id);
    return kind + '|' + conv + '|' + String(e.from || '') + '|' + String(e.text || '').slice(0, 60);
  }

  function createEngine(opts) {
    const o = opts || {};
    const clock = typeof o.now === 'function' ? o.now : () => Date.now();
    const maxBubbles = o.maxBubbles || MAX_BUBBLES;

    const seen = new Map(); // 指纹 -> 时间
    const convs = new Map(); // key -> 会话状态
    const muted = new Map(); // key -> { kind, convId, name }（记名字，设置页才看得懂在静音谁）
    let globalOn = o.globalOn !== false;

    function memSweep(t) {
      if (seen.size < DUP_CAP) return;
      for (const [k, ts] of seen) if (t - ts > DUP_TTL) seen.delete(k);
      if (seen.size > DUP_CAP) {
        const over = seen.size - DUP_CAP;
        let i = 0;
        for (const k of seen.keys()) {
          if (i++ >= over) break;
          seen.delete(k);
        }
      }
    }

    function isMuted(kind, convId) {
      return muted.has(String(kind) + ':' + String(convId || 'default'));
    }

    function visibleCount() {
      let n = 0;
      for (const c of convs.values()) if (c.visible) n++;
      return n;
    }

    /* 把排队等位的会话提上来（泡泡被关掉一个就补一个） */
    function promote() {
      if (visibleCount() >= maxBubbles) return null;
      let pick = null;
      for (const c of convs.values()) {
        if (c.visible || c.count <= 0) continue;
        if (!pick || c.lastTs < pick.lastTs) pick = c;
      }
      if (pick) {
        pick.visible = true;
        pick.promotedAt = clock();
      }
      return pick;
    }

    function ensure(evt) {
      const key = keyOf(evt);
      let c = convs.get(key);
      if (!c) {
        c = {
          key,
          kind: String(evt.kind || 'system'),
          convId: String(evt.convId || 'default'),
          name: String(evt.name || evt.from || KINDS[evt.kind]?.label || '消息'),
          avatar: String(evt.avatar || (KINDS[evt.kind] || KINDS.system).icon),
          text: '',
          count: 0,
          unread: 0,
          firstTs: 0,
          lastTs: 0,
          visible: false,
          offline: false,
          mention: false,
        };
        convs.set(key, c);
      }
      if (evt.name) c.name = String(evt.name);
      if (evt.avatar) c.avatar = String(evt.avatar);
      return c;
    }

    /* 单条推送。返回 {action, conv, queued, promoted}
       action: dup 重复丢弃 / off 全局关闭 / muted 会话静音 / bubble 弹泡 / counted 已计入未弹 */
    function push(evt) {
      if (!evt) return { action: 'dup' };
      const t = clock();
      const fp = fingerprint(evt);
      const prev = seen.get(fp);
      if (prev && t - prev < DUP_TTL) return { action: 'dup', fp };
      seen.set(fp, t);
      memSweep(t);

      const c = ensure(evt);
      const isNew = c.count === 0;
      const n = Math.max(1, Math.min(999, Number(evt.count) || 1));
      c.count += n;
      c.unread += n;
      c.text = String(evt.text == null ? '' : evt.text).slice(0, 400);
      c.lastTs = t;
      if (!c.firstTs) c.firstTs = t;
      if (evt.mention) c.mention = true;
      if (evt.offline) c.offline = true;

      if (!globalOn) return { action: 'off', conv: c };
      if (isMuted(c.kind, c.convId)) return { action: 'muted', conv: c };

      const wasVisible = c.visible;
      if (!wasVisible) {
        if (visibleCount() >= maxBubbles) return { action: 'counted', conv: c, queued: true };
        c.visible = true;
      }
      return { action: 'bubble', conv: c, isNew: !wasVisible && isNew, mention: !!c.mention };
    }

    /* 离线堆积：一批消息进来，按会话聚合，每会话只留一个泡泡 + 条数 */
    function pushBatch(list) {
      const out = [];
      const t = clock();
      const byConv = new Map();
      for (const evt of list || []) {
        if (!evt) continue;
        const fp = fingerprint(evt);
        const prev = seen.get(fp);
        if (prev && t - prev < DUP_TTL) continue;
        seen.set(fp, t);
        const k = keyOf(evt);
        let g = byConv.get(k);
        if (!g) {
          g = { evt, n: 0 };
          byConv.set(k, g);
        }
        g.n += 1;
        g.evt = evt; // 保留最后一条做正文
      }
      for (const g of byConv.values()) {
        const c = ensure(g.evt);
        c.count += g.n;
        c.unread += g.n;
        c.offline = true;
        c.text = String(g.evt.text || '').slice(0, 400);
        c.lastTs = t;
        if (!c.firstTs) c.firstTs = t - 1;
        if (isMuted(c.kind, c.convId) || !globalOn) {
          out.push({ action: isMuted(c.kind, c.convId) ? 'muted' : 'off', conv: c });
          continue;
        }
        if (!c.visible) {
          if (visibleCount() >= maxBubbles) {
            out.push({ action: 'counted', conv: c, queued: true });
            continue;
          }
          c.visible = true;
        }
        out.push({ action: 'bubble', conv: c, offline: true });
      }
      memSweep(t);
      return out;
    }

    function close(key) {
      const c = convs.get(String(key));
      if (!c) return null;
      c.visible = false;
      c.count = 0;
      const nx = promote();
      return { closed: c, promoted: nx };
    }

    function closeAll() {
      const out = [];
      for (const c of convs.values()) {
        if (!c.visible) continue;
        c.visible = false;
        c.count = 0;
        out.push(c);
      }
      return out;
    }

    function markRead(key) {
      const c = convs.get(String(key));
      if (!c) return;
      c.unread = 0;
      c.count = 0;
      c.visible = false;
      c.mention = false;
      promote();
    }

    function visible() {
      return [...convs.values()].filter((c) => c.visible).sort((a, b) => a.lastTs - b.lastTs);
    }

    function queued() {
      return [...convs.values()].filter((c) => !c.visible && c.count > 0);
    }

    function unreadByKind() {
      const m = {};
      for (const c of convs.values()) {
        if (c.unread > 0) m[c.kind] = (m[c.kind] || 0) + c.unread;
      }
      return m;
    }

    function unreadTotal() {
      let n = 0;
      for (const c of convs.values()) n += c.unread || 0;
      return n;
    }

    function mute(kind, convId, name) {
      const key = String(kind) + ':' + String(convId || 'default');
      const c = convs.get(key);
      muted.set(key, { kind: String(kind), convId: String(convId || 'default'), name: String(name || (c && c.name) || '') });
      if (c) c.visible = false;
      return list();
    }

    function unmute(kind, convId) {
      muted.delete(String(kind) + ':' + String(convId || 'default'));
      return list();
    }

    function list() {
      return [...muted.values()].map((v) => ({ ...v }));
    }

    function setGlobal(on) {
      globalOn = !!on;
      if (!globalOn) closeAll();
      return globalOn;
    }

    function serialize() {
      return { globalOn, muted: list() };
    }

    function restore(d) {
      if (!d) return;
      if (typeof d.globalOn === 'boolean') globalOn = d.globalOn;
      if (Array.isArray(d.muted)) {
        muted.clear();
        for (const it of d.muted) {
          if (!it || !it.kind) continue;
          muted.set(String(it.kind) + ':' + String(it.convId || 'default'), {
            kind: String(it.kind),
            convId: String(it.convId || 'default'),
            name: String(it.name || ''),
          });
        }
      }
    }

    return {
      KINDS,
      push,
      pushBatch,
      close,
      closeAll,
      markRead,
      visible,
      queued,
      unreadByKind,
      unreadTotal,
      mute,
      unmute,
      isMuted,
      list,
      setGlobal,
      getGlobal: () => globalOn,
      serialize,
      restore,
      fingerprint,
      keyOf,
      _convs: convs,
    };
  }

  /* ---------------- DOM 层 ---------------- */

  const LS_KEY = 'pq.msgCenter.v1';
  const STATE_KEY = 'pq.msgRead.v1';
  const EXPIRE = 6500; // 泡泡停留时间；鼠标悬停时暂停

  function init(opts) {
    const o = opts || {};
    const engine = createEngine({ now: () => Date.now() });
    const timers = new Map();
    let host = null;
    let onJump = typeof o.onJump === 'function' ? o.onJump : () => {};

    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) engine.restore(JSON.parse(raw));
    } catch (_) {}

    function persist() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(engine.serialize()));
      } catch (_) {}
    }

    function mountHost() {
      if (host || typeof document === 'undefined') return host;
      host = document.createElement('div');
      host.id = 'msgpop-root';
      host.className = 'msgpop-root';
      /* 必须挂进 #app：主题色变量定义在 #app[data-theme] 上，
         挂 body 会取不到 --text / --panel-solid，弹窗会变成黑底黑字 */
      const appEl = document.getElementById('app');
      (appEl || document.body).appendChild(host);
      return host;
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    function clockText(ts) {
      const d = new Date(ts || Date.now());
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    function paint(c) {
      mountHost();
      let el = host.querySelector(`[data-key="${CSS.escape(c.key)}"]`);
      const kind = KINDS[c.kind] || KINDS.system;
      const countTxt =
        c.count > 1 ? `<span class="msgpop-count">${c.count} 条新消息</span>` : c.offline ? '<span class="msgpop-count">离线消息</span>' : '';
      const html = `
        <div class="msgpop-av">${esc(c.avatar)}</div>
        <div class="msgpop-main">
          <div class="msgpop-top">
            <span class="msgpop-name">${esc(c.name)}</span>
            <span class="msgpop-tag">${esc(kind.label)}</span>
            ${c.mention ? '<span class="msgpop-at">@ 你</span>' : ''}
            <span class="msgpop-time">${clockText(c.lastTs)}</span>
          </div>
          <div class="msgpop-text">${esc(c.text || '（没有文字内容）')}</div>
          ${countTxt}
        </div>
        <div class="msgpop-tools">
          <button class="msgpop-btn" data-act="mute" title="这个会话不再弹窗（未读照常记录）">🔕</button>
          <button class="msgpop-btn" data-act="close" title="关掉">✕</button>
        </div>`;
      if (!el) {
        el = document.createElement('div');
        el.className = 'msgpop' + (c.offline ? ' offline' : '') + (c.mention ? ' mention' : '');
        el.dataset.key = c.key;
        el.innerHTML = html;
        host.appendChild(el);
        requestAnimationFrame(() => el.classList.add('in'));
        bind(el, c.key);
      } else {
        el.innerHTML = html;
        el.classList.toggle('offline', !!c.offline);
        el.classList.toggle('mention', !!c.mention);
        el.classList.add('bump');
        setTimeout(() => el && el.classList.remove('bump'), 260);
        bind(el, c.key);
      }
      armTimer(c.key, c.offline ? EXPIRE + 2500 : EXPIRE);
    }

    function bind(el, key) {
      el.onclick = (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
        const act = btn && btn.dataset.act;
        if (act === 'close') {
          e.stopPropagation();
          drop(key);
          return;
        }
        if (act === 'mute') {
          e.stopPropagation();
          const c = engine._convs.get(key);
          if (c) engine.mute(c.kind, c.convId, c.name);
          drop(key);
          persist();
          if (typeof o.onMute === 'function') o.onMute(key);
          return;
        }
        const c = engine._convs.get(key);
        if (!c) return;
        engine.markRead(key);
        drop(key, true);
        onJump(c.kind, c.convId, c);
      };
      el.onmouseenter = () => disarm(key);
      el.onmouseleave = () => armTimer(key, 2600);
    }

    function armTimer(key, ms) {
      disarm(key);
      timers.set(
        key,
        setTimeout(() => drop(key), ms)
      );
    }

    function disarm(key) {
      const t = timers.get(key);
      if (t) clearTimeout(t);
      timers.delete(key);
    }

    function drop(key, silent) {
      disarm(key);
      const r = engine.close(key);
      const el = host && host.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (el) {
        el.classList.remove('in');
        el.classList.add('out');
        setTimeout(() => el.remove(), 200);
      }
      if (!silent && r && r.promoted) paint(r.promoted);
      if (r && r.promoted) armTimer(r.promoted.key, EXPIRE);
      return r;
    }

    function push(evt) {
      const r = engine.push(evt);
      if (r.action === 'bubble') paint(r.conv);
      if (r.action === 'counted') paintQueuedBadge();
      return r;
    }

    function pushBatch(list) {
      const rs = engine.pushBatch(list);
      for (const r of rs) if (r.action === 'bubble') paint(r.conv);
      return rs;
    }

    function paintQueuedBadge() {
      mountHost();
      const n = engine.queued().length;
      let b = host.querySelector('.msgpop-more');
      if (!n) {
        if (b) b.remove();
        return;
      }
      if (!b) {
        b = document.createElement('div');
        b.className = 'msgpop-more';
        host.appendChild(b);
      }
      b.textContent = `还有 ${n} 个会话有新消息`;
    }

    return {
      engine,
      push,
      pushBatch,
      drop,
      paint,
      persist,
      unreadByKind: () => engine.unreadByKind(),
      unreadTotal: () => engine.unreadTotal(),
      mute: (k, i) => {
        engine.mute(k, i);
        persist();
      },
      unmute: (k, i) => {
        engine.unmute(k, i);
        persist();
      },
      list: () => engine.list(),
      setGlobal: (on) => {
        const r = engine.setGlobal(on);
        persist();
        return r;
      },
      getGlobal: () => engine.getGlobal(),
      clear: () => {
        engine.closeAll();
        if (host) host.innerHTML = '';
      },
    };
  }

  return { KINDS, createEngine, init, DUP_TTL, MAX_BUBBLES };
});
