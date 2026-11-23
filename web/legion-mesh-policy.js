/* PlanQuest · 军团网格策略（纯函数）
 *
 * 军团异地联机的「判断部分」单独放这里：谁该当副主、先直连还是先中继、
 * 什么时候轮换密钥、名册怎么合并。全部是不带副作用的纯函数，
 * 这样 dev-tests 可以直接 require 进来跑断言，不用起 WebRTC、不用开界面。
 *
 * 真正的连接（RTCPeerConnection / DataChannel）在 legion-mesh.js 里，
 * 信令通道（房主 <-> 成员）在 legion-p2p.js 里。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PQMeshPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------- 信誉档位（与主进程 credit 同一套阈值） ---------------- */
  const TIERS = [
    { min: 0, name: '受限', icon: '⛔' },
    { min: 80, name: '普通', icon: '🥉' },
    { min: 100, name: '良好', icon: '🥈' },
    { min: 120, name: '可信', icon: '🥇' },
  ];

  function clampScore(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(160, Math.round(n)));
  }

  function tierOf(score) {
    const s = clampScore(score);
    let t = TIERS[0];
    for (const x of TIERS) if (s >= x.min) t = x;
    return t;
  }

  /* ---------------- 名册清洗 ---------------- */

  /* 公钥：P-256 raw 是 65 字节 → base64url 87 字符。放宽到 40 字符以上，
     兼容将来换曲线；但绝不放任何非 base64url 字符进去（防止被塞协议字段）。 */
  function cleanPub(v) {
    const s = String(v || '');
    return /^[A-Za-z0-9_-]{40,200}$/.test(s) ? s : '';
  }

  function clean(m) {
    const o = m && typeof m === 'object' ? m : {};
    return {
      uid: String(o.uid || '').slice(0, 40),
      alias: String(o.alias || '').slice(0, 12),
      credit: clampScore(o.credit),
      pub: cleanPub(o.pub),
      joinedAt: Number(o.joinedAt) || 0,
      at: Number(o.at) || 0,
    };
  }

  /* ---------------- 副主选举 ----------------
   * 房主挂了以后谁接管信令？三条依次比较，保证所有端算出同一个答案：
   *   1) 信誉分高的先（这是「靠谱」的唯一硬指标）
   *   2) 同分看谁先入团（老成员更稳，也更可能是熟人）
   *   3) 再同就比 uid 字典序（纯为了确定性，不代表优劣）
   */
  function rank(list) {
    return (Array.isArray(list) ? list : [])
      .map(clean)
      .filter((m) => m.uid)
      .sort(
        (a, b) =>
          b.credit - a.credit ||
          a.joinedAt - b.joinedAt ||
          (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)
      );
  }

  function electDeputy(list) {
    const r = rank(list);
    return r.length ? r[0].uid : '';
  }

  /* 候补名单：把自己排进去，才知道「该不该我来接管」 */
  function candidates(list, self) {
    const all = (Array.isArray(list) ? list : []).slice();
    if (self && self.uid && !all.some((m) => m && m.uid === self.uid)) all.push(self);
    return rank(all);
  }

  function shouldTakeOver(list, selfUid) {
    const r = candidates(list, { uid: selfUid });
    return !!(r.length && r[0].uid === selfUid);
  }

  /* ---------------- 连接阶梯 ----------------
   * 第一级只靠 STUN 打洞：最快、不经第三方。
   * 打洞失败（对称 NAT / 严防火墙）才挂 TURN 重来一遍，而不是一上来就中继。
   * 用户手动选「纯中继」时直接从第二级开始。
   */
  const LADDER = [
    { step: 'direct', label: '直连', timeoutMs: 8000, addTurn: false },
    { step: 'relay', label: '中继', timeoutMs: 12000, addTurn: true },
  ];

  function ladder(mode) {
    return mode === 'relay' ? [LADDER[1]] : LADDER.slice();
  }

  function stepAt(n) {
    return LADDER[Math.max(0, Math.min(LADDER.length - 1, Number(n) || 0))];
  }

  /* ---------------- 链路分类 ----------------
   * 连上之后回头看 ICE 选中的候选对：走的是本地网卡/公网直连，还是 TURN 中继。
   * 注意 Tailscale / ZeroTier 这类组网，在 WebRTC 眼里就是「一张普通网卡」，
   * 所以它算直连 —— 但会在界面上单独标「组网」，免得用户以为暴露了公网地址。
   */
  function classifyPair(pairs) {
    const list = Array.isArray(pairs) ? pairs : [];
    const p = list.find((x) => x && (x.state === 'succeeded' || x.selected)) || null;
    if (!p) return 'none';
    const lt = String(p.localCandidateType || (p.local && p.local.candidateType) || '');
    const rt = String(p.remoteCandidateType || (p.remote && p.remote.candidateType) || '');
    if (lt === 'relay' || rt === 'relay') return 'relay';
    const addr = String((p.remote && p.remote.address) || p.remoteAddress || '');
    return isOverlayAddr(addr) ? 'overlay' : 'direct';
  }

  /* 100.64.0.0/10 = CGNAT，Tailscale 默认就在这一段 */
  function isOverlayAddr(addr) {
    const m = String(addr || '').match(/^(\d{1,3})\.(\d{1,3})\./);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 100 && b >= 64 && b <= 127;
  }

  /* ---------------- 密钥轮换 ----------------
   * 每一对成员一把独立的 AES-GCM 密钥（ECDH 现场算，房主看不到）。
   * 到点换一次；名册一变（有人进/出）也立刻换，免得旧成员拿着旧密钥还能解。
   */
  function needRotate(now, lastAt, opts) {
    const o = opts || {};
    const every = Number(o.everyMs) || 30 * 60 * 1000;
    if (!lastAt) return true;
    if (o.rosterChanged) return true;
    return Number(now) - Number(lastAt) >= every;
  }

  function rotateLeft(now, lastAt, everyMs) {
    if (!lastAt) return 0;
    const every = Number(everyMs) || 30 * 60 * 1000;
    return Math.max(0, every - (Number(now) - Number(lastAt)));
  }

  /* ---------------- 名册合并 ----------------
   * incoming 是权威名单（房主/副主广播的）。返回新增、变更、离开三份差异，
   * 上层据此只对「变化的那几个」重建连接，而不是全部推倒重来。
   */
  function mergeRoster(cur, incoming) {
    const before = new Map();
    for (const m of Array.isArray(cur) ? cur : []) {
      const c = clean(m);
      if (c.uid) before.set(c.uid, c);
    }
    const after = new Map();
    const added = [];
    const updated = [];
    for (const m of Array.isArray(incoming) ? incoming : []) {
      const c = clean(m);
      if (!c.uid) continue;
      const old = before.get(c.uid);
      if (!old) added.push(c);
      else if (old.alias !== c.alias || old.credit !== c.credit || old.pub !== c.pub) updated.push(c);
      after.set(c.uid, c);
    }
    const removed = [...before.keys()].filter((u) => !after.has(u));
    return { list: [...after.values()], added, updated, removed };
  }

  /* ---------------- 拓扑统计（界面用） ---------------- */
  function topo(peers) {
    const out = { direct: 0, overlay: 0, relay: 0, down: 0, total: 0 };
    for (const p of Array.isArray(peers) ? peers : []) {
      out.total++;
      const s = String((p && p.state) || '');
      if (s === 'direct') out.direct++;
      else if (s === 'overlay') out.overlay++;
      else if (s === 'relay') out.relay++;
      else out.down++;
    }
    return out;
  }

  function topoText(t) {
    const x = t || { direct: 0, overlay: 0, relay: 0, down: 0, total: 0 };
    if (!x.total) return '还没有其他成员';
    const bits = [];
    if (x.direct) bits.push(`直连 ${x.direct}`);
    if (x.overlay) bits.push(`组网 ${x.overlay}`);
    if (x.relay) bits.push(`中继 ${x.relay}`);
    if (x.down) bits.push(`未连通 ${x.down}`);
    return bits.join(' · ');
  }

  return {
    TIERS,
    clampScore,
    tierOf,
    clean,
    cleanPub,
    rank,
    electDeputy,
    candidates,
    shouldTakeOver,
    LADDER,
    ladder,
    stepAt,
    classifyPair,
    isOverlayAddr,
    needRotate,
    rotateLeft,
    mergeRoster,
    topo,
    topoText,
  };
});
