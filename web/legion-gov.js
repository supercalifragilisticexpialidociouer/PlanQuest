/* PlanQuest · 军团治理（团内目录 / 信誉等级 / 投票选职务 / 举报乱发 / 职务权限）
 *
 * 设计原则：
 *   1. 所有结论都能被任何人独立算出同一个答案（纯函数 + 不依赖本地时钟偏移）
 *      —— 投票结果按 (同意, 反对, 参与人数, 名册人数) 四个数算，不做随机、不做加权。
 *   2. 发起投票有成本：地位门槛（普通及以上）+ 每日次数 + 同时在场数量上限。
 *      防的不是"有意见"，防的是"用投票刷屏"。
 *   3. 乱发投票会被集体否决：≥3 个不同的人举报 → 该投票作废 + 24 小时禁发起 + 扣信誉分。
 *   4. 职务只给权限，不给分数：职务不能换信誉分，也不能改别人的分；只能做流程上的事
 *      （发起/裁定投票、禁言、看审计）。
 */
'use strict';

(function (root) {
  /* ---------------- 信誉等级（与翻案分档同源） ---------------- */
  const TIERS = [
    { min: 0, name: '受限', icon: '⛔', short: '青' },
    { min: 80, name: '普通', icon: '🥉', short: '银' },
    { min: 100, name: '良好', icon: '🥈', short: '金' },
    { min: 120, name: '可信', icon: '🥇', short: '钻' },
  ];

  function clampScore(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(160, Math.round(n)));
  }

  function tierIndex(score) {
    const s = clampScore(score);
    let i = 0;
    TIERS.forEach((t, k) => {
      if (s >= t.min) i = k;
    });
    return i;
  }

  function tierOf(score) {
    return TIERS[tierIndex(score)];
  }

  /* 只对外暴露等级，不暴露分数：军团里看到的是「🥈 良好」，不是 103 分 */
  function tierBadge(score) {
    const t = tierOf(score);
    return { name: t.name, icon: t.icon, idx: tierIndex(score) };
  }

  /* ---------------- 职务与权限 ---------------- */
  const ROLES = {
    deputy: { id: 'deputy', name: '副团长', icon: '🎖', desc: '团长离线时维持秩序，可发起投票、禁言', perms: ['vote.start', 'mute', 'assign.ask'] },
    judge: { id: 'judge', name: '纪律官', icon: '⚖️', desc: '处理频道刷屏与辱骂，可发起投票、禁言、裁定投票', perms: ['vote.start', 'mute', 'vote.certify'] },
    arbiter: { id: 'arbiter', name: '仲裁员', icon: '🧑‍⚖️', desc: '审核发言是否摸鱼，参与争议裁定', perms: ['vote.certify', 'speech.judge'] },
    scribe: { id: 'scribe', name: '记录官', icon: '📜', desc: '查看审计记录，保存投票与纪律台账', perms: ['audit.view'] },
  };

  const PERMS = {
    'vote.start': '发起投票',
    mute: '禁言成员',
    'vote.certify': '裁定争议投票',
    'speech.judge': '审核发言是否摸鱼',
    'assign.ask': '提议任命职务（发起职务投票）',
    'audit.view': '查看审计记录',
  };

  const ROLE_LIST = Object.keys(ROLES).map((k) => ROLES[k]);

  /* ---------------- 投票规则 ---------------- */
  const TYPES = {
    /* 职务只能投票产生：团长也没有直接任命权，有「提议任命职务」权限的职务同样可以发起 */
    role: { id: 'role', name: '选职务', hostOnly: false, perm: 'assign.ask', desc: '投票任命：团长或有「提议任命职务」权限的人发起，大家表决' },
    speech: { id: 'speech', name: '发言审核', hostOnly: false, desc: '判断某条发言是摸鱼还是正经事' },
    other: { id: 'other', name: '其他事项', hostOnly: false, desc: '团内任何需要表态的事' },
  };

  const LIMITS = {
    VOTE_MS: 10 * 60e3, // 一个投票开 10 分钟
    MIN_TIER: 1, // 普通及以上才能发起
    DAILY: { 1: 2, 2: 3, 3: 4 }, // 按等级给每日发起次数
    MAX_OPEN: 2, // 同时进行中的投票上限（团长的选职务投票不占这个额度）
    QUORUM_RATIO: 0.5, // 在线成员过半参与才算数
    MIN_PARTICIPANTS: 2, // 至少 2 人
    PASS_RATIO: 0.6, // 同意占比 ≥ 60% 且同意 > 反对
    REPORT_VOID: 3, // ≥3 个不同的人举报 → 作废
    REPORT_BAN_MS: 24 * 3600e3, // 乱发 → 24 小时禁发起
    REPORT_PENALTY: 3, // 乱发扣 3 分
    SMALL_LEGION: 4, // 少于 4 人时，团长可直接任命（凑不够法定人数）
  };

  function dayKey(now) {
    const d = new Date(Number(now) || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function normState(st) {
    const o = st && typeof st === 'object' ? st : {};
    return {
      votes: Array.isArray(o.votes) ? o.votes : [],
      roles: o.roles && typeof o.roles === 'object' ? o.roles : {},
      reports: Array.isArray(o.reports) ? o.reports : [],
      daily: o.daily && typeof o.daily === 'object' ? o.daily : {},
      bans: o.bans && typeof o.bans === 'object' ? o.bans : {},
      log: Array.isArray(o.log) ? o.log : [],
    };
  }

  /* 今日剩余发起次数 */
  function leftToday(state, uid, tier, now) {
    const st = normState(state);
    const day = dayKey(now);
    const rec = st.daily[uid];
    const used = rec && rec.day === day ? Number(rec.n) || 0 : 0;
    const cap = LIMITS.DAILY[tier] != null ? LIMITS.DAILY[tier] : 0;
    return Math.max(0, cap - used);
  }

  function bannedUntil(state, uid) {
    const st = normState(state);
    return Number((st.bans || {})[uid]) || 0;
  }

  /* 能否发起：返回 { ok, message } */
  function canStart(state, opts) {
    const st = normState(state);
    const o = opts || {};
    const now = Number(o.now) || Date.now();
    const tier = Number(o.tier);
    const uid = String(o.uid || '');
    const type = TYPES[o.type] ? o.type : 'other';

    if (!uid) return { ok: false, message: '还没进房间' };
    if (type === 'role') {
      /* 谁能发起职务投票：团长，或拿到「提议任命职务」权限的职务（副团长）。其他人不行。 */
      const okBy = !!o.isHost || (Array.isArray(o.perms) && o.perms.includes('assign.ask'));
      if (!okBy) return { ok: false, message: '职务投票只有团长和副团长能发起' };
      const ban = bannedUntil(st, uid);
      if (ban > now) {
        const h = Math.ceil((ban - now) / 3600e3);
        return { ok: false, message: `你因为乱发投票被禁发起，还有约 ${h} 小时` };
      }
      /* 每人最多一个职务：候选人已经有职务的，先投撤销再谈新的 */
      const roles = o.roles && typeof o.roles === 'object' ? o.roles : {};
      if (o.target && roles[String(o.target)]) {
        return { ok: false, message: '每人最多一个职务：他已经有一个了，先发起投票撤销' };
      }
      return { ok: true, message: '' };
    }
    if (!Number.isFinite(tier) || tier < LIMITS.MIN_TIER) {
      return { ok: false, message: '信誉等级不够（需要「普通」及以上），先打卡与助人把分挣回来' };
    }
    const ban = bannedUntil(st, uid);
    if (ban > now) {
      const h = Math.ceil((ban - now) / 3600e3);
      return { ok: false, message: `你因为乱发投票被禁发起，还有约 ${h} 小时` };
    }
    if (leftToday(st, uid, tier, now) <= 0) {
      return { ok: false, message: '今天的发起次数用完了（普通 2 次 / 良好 3 次 / 可信 4 次）' };
    }
    const open = st.votes.filter((v) => v && v.status === 'open' && v.by === uid && v.type !== 'role').length;
    if (open >= LIMITS.MAX_OPEN) return { ok: false, message: `你手上有 ${open} 个投票还没结束，先等它出结果` };
    return { ok: true, message: '' };
  }

  function newVote(opts) {
    const o = opts || {};
    const now = Number(o.now) || Date.now();
    const type = TYPES[o.type] ? o.type : 'other';
    return {
      id: String(o.id || 'v-' + now.toString(36) + Math.random().toString(36).slice(2, 5)),
      type,
      by: String(o.by || ''),
      byAlias: String(o.byAlias || '').slice(0, 12),
      byTier: tierIndex(o.byTier),
      target: String(o.target || ''),
      targetAlias: String(o.targetAlias || '').slice(0, 12),
      role: type === 'role' ? String(o.role || '') : '',
      question: String(o.question || '').slice(0, 120),
      speech: o.speech && typeof o.speech === 'object'
        ? { msgId: String(o.speech.msgId || ''), current: o.speech.current === 'fish' ? 'fish' : 'work', text: String(o.speech.text || '').slice(0, 80) }
        : null,
      createdAt: now,
      endsAt: now + (Number(o.ms) > 0 ? Number(o.ms) : LIMITS.VOTE_MS),
      status: 'open',
      votes: {},
      reports: [],
      result: null,
    };
  }

  function cast(vote, uid, choice, now) {
    if (!vote || vote.status !== 'open') return { ok: false, message: '这个投票已经结束' };
    if (Number(now) >= Number(vote.endsAt)) return { ok: false, message: '投票已到时间' };
    const id = String(uid || '');
    if (!id) return { ok: false, message: '没有身份' };
    if (vote.by === id) return { ok: false, message: '自己发起的投票不能自己投' };
    const c = choice === 'yes' ? 'yes' : choice === 'no' ? 'no' : '';
    if (!c) return { ok: false, message: '只能选同意或反对' };
    vote.votes = vote.votes && typeof vote.votes === 'object' ? vote.votes : {};
    vote.votes[id] = c;
    return { ok: true, message: '' };
  }

  /* 记名统计：任何一端算出的结果都一样 */
  function tally(vote, rosterSize, now) {
    const v = vote || {};
    const joined = Object.keys(v.votes || {}).length;
    let yes = 0;
    let no = 0;
    for (const k of Object.keys(v.votes || {})) {
      if (v.votes[k] === 'yes') yes += 1;
      else if (v.votes[k] === 'no') no += 1;
    }
    const total = Math.max(1, Number(rosterSize) || 1);
    const need = Math.max(LIMITS.MIN_PARTICIPANTS, Math.ceil(total * LIMITS.QUORUM_RATIO));
    const quorum = joined >= need;
    const pass = quorum && yes > no && yes / Math.max(1, yes + no) >= LIMITS.PASS_RATIO;
    const expired = Number(now) >= Number(v.endsAt || 0);
    let status = 'open';
    if (v.status && v.status !== 'open') status = v.status;
    else if (joinQ(v) >= LIMITS.REPORT_VOID) status = 'void';
    else if (expired) status = pass ? 'pass' : 'fail';
    return {
      status,
      yes,
      no,
      joined,
      need,
      quorum,
      pass,
      expired,
      leftMs: Math.max(0, Number(v.endsAt || 0) - Number(now || 0)),
    };
  }

  function joinQ(v) {
    const r = v && Array.isArray(v.reports) ? v.reports : [];
    return new Set(r.map(String)).size;
  }

  /* 举报：返回 { ok, voided, reports } */
  function report(vote, uid, now) {
    if (!vote) return { ok: false, message: '没有这个投票' };
    if (vote.status !== 'open') return { ok: false, message: '这个投票已经结束了' };
    const id = String(uid || '');
    if (!id) return { ok: false, message: '没有身份' };
    if (vote.by === id) return { ok: false, message: '不能举报自己发起的投票' };
    vote.reports = Array.isArray(vote.reports) ? vote.reports : [];
    if (vote.reports.includes(id)) return { ok: false, message: '你已经举报过了' };
    vote.reports.push(id);
    const n = joinQ(vote);
    if (n >= LIMITS.REPORT_VOID) {
      vote.status = 'void';
      vote.result = { voidBy: 'report', reports: n, at: Number(now) || Date.now() };
      return { ok: true, voided: true, reports: n };
    }
    return { ok: true, voided: false, reports: n };
  }

  /* 结束投票并写入结果（幂等：已结束的原样返回） */
  function settle(vote, rosterSize, now) {
    if (!vote) return null;
    if (vote.status !== 'open') return tally(vote, rosterSize, now);
    const t = tally(vote, rosterSize, now);
    if (t.status === 'open') return t;
    vote.status = t.status;
    vote.result = {
      yes: t.yes,
      no: t.no,
      joined: t.joined,
      need: t.need,
      quorum: t.quorum,
      at: Number(now) || Date.now(),
    };
    return t;
  }

  /* 职务 */
  function roleOf(roles, uid) {
    const r = (roles || {})[String(uid || '')];
    return ROLES[r] ? ROLES[r] : null;
  }

  function permsOf(roles, uid) {
    const r = roleOf(roles, uid);
    return r ? r.perms.slice() : [];
  }

  function hasPerm(roles, uid, perm) {
    return permsOf(roles, uid).includes(String(perm));
  }

  function assign(roles, uid, roleId) {
    const out = { ...(roles || {}) };
    const id = String(uid || '');
    if (!id) return { ok: false, message: '没有这个人', roles: out };
    if (roleId == null || roleId === '') {
      delete out[id];
      return { ok: true, roles: out, role: null };
    }
    if (!ROLES[roleId]) return { ok: false, message: '没有这个职务', roles: out };
    /* 一人一职：已经有职务的人不能再领新的，得先撤销 */
    if (out[id]) return { ok: false, message: `每人最多一个职务（他现在是${ROLES[out[id]] ? ROLES[out[id]].name : '某职务'}），先撤销再任命`, roles: out };
    out[id] = roleId;
    return { ok: true, roles: out, role: ROLES[roleId] };
  }

  /* 候选人排序：等级高的在前，同等级按入团时间早的在前（uid 兜底保证确定性） */
  function candidates(roster) {
    const list = Array.isArray(roster) ? roster.slice() : [];
    return list
      .map((m) => ({
        uid: String(m.uid || ''),
        alias: String(m.alias || '成员').slice(0, 12),
        credit: clampScore(m.credit),
        tier: tierIndex(m.credit),
        joinedAt: Number(m.joinedAt) || 0,
      }))
      .filter((m) => m.uid)
      .sort((a, b) => b.tier - a.tier || a.joinedAt - b.joinedAt || a.uid.localeCompare(b.uid));
  }

  /* ---------------- 团长选举（团长退团后，全团投票选出新团长） ----------------
   * 选举对象在退团的团长机器上生成，经频道/网格广播给每个成员；
   * 每台机器本地记候选人、记票，结算用同一份纯函数 → 全员算出同一个新团长。 */
  const ELECTION_MS = 10 * 60e3; // 选举开 10 分钟
  const MAX_CANDIDATES = 8;

  function normalizeElection(raw) {
    const e = raw && typeof raw === 'object' ? raw : {};
    const now = Date.now();
    const out = {
      id: String(e.id || '').slice(0, 40),
      prevUid: String(e.prevUid || '').slice(0, 40),
      prevAlias: String(e.prevAlias || '').slice(0, 12),
      startedAt: Number(e.startedAt) || now,
      endsAt: Number(e.endsAt) || now + ELECTION_MS,
      candidates: [],
      ballots: {},
      status: 'open',
      result: null,
    };
    const cands = Array.isArray(e.candidates) ? e.candidates.slice(0, MAX_CANDIDATES) : [];
    for (const c of cands) {
      const uid = String((c && c.uid) || '').slice(0, 40);
      if (!uid || out.candidates.some((x) => x.uid === uid)) continue;
      out.candidates.push({
        uid,
        alias: String((c && c.alias) || '成员').slice(0, 12),
        credit: clampScore(c && c.credit),
        tier: tierIndex(c && c.credit),
      });
    }
    if (e.ballots && typeof e.ballots === 'object') {
      for (const k of Object.keys(e.ballots).slice(0, 500)) {
        const v = String(e.ballots[k]).slice(0, 40);
        if (v && out.candidates.some((c) => c.uid === v)) out.ballots[String(k).slice(0, 40)] = v;
      }
    }
    if (e.status === 'pass' || e.status === 'fail') {
      out.status = e.status;
      out.result = e.result ? String(e.result).slice(0, 40) : null;
    }
    return out;
  }

  function newElection({ prevUid, prevAlias, now, ms } = {}) {
    const t = Number(now) || Date.now();
    return normalizeElection({
      id: 'host-' + t.toString(36) + Math.random().toString(36).slice(2, 5),
      prevUid: String(prevUid || ''),
      prevAlias: String(prevAlias || '').slice(0, 12),
      startedAt: t,
      endsAt: t + (Number(ms) > 0 ? Number(ms) : ELECTION_MS),
      status: 'open',
    });
  }

  /* 参选：任何普通及以上成员都可以把自己报上来 */
  function campaign(el, uid, alias, credit, now) {
    const e = normalizeElection(el);
    if (e.status !== 'open') return { ok: false, message: '选举已经结束' };
    if (Number(now) >= Number(e.endsAt)) return { ok: false, message: '选举已经到时间' };
    const id = String(uid || '').slice(0, 40);
    if (!id) return { ok: false, message: '没有身份' };
    if (e.candidates.some((c) => c.uid === id)) return { ok: false, message: '你已经在候选人里了' };
    if (e.candidates.length >= MAX_CANDIDATES) return { ok: false, message: `候选人已满（最多 ${MAX_CANDIDATES} 人）` };
    e.candidates.push({
      uid: id,
      alias: String(alias || '成员').slice(0, 12),
      credit: clampScore(credit),
      tier: tierIndex(credit),
    });
    return { ok: true, election: e };
  }

  /* 投票：一人一票，改票只留最后一次；只能投给已参选的人 */
  function castBallot(el, voter, choice, now) {
    const e = normalizeElection(el);
    if (e.status !== 'open') return { ok: false, message: '选举已经结束' };
    if (Number(now) >= Number(e.endsAt)) return { ok: false, message: '选举已经到时间' };
    const v = String(voter || '').slice(0, 40);
    if (!v) return { ok: false, message: '没有身份' };
    const c = String(choice || '').slice(0, 40);
    if (!e.candidates.some((x) => x.uid === c)) return { ok: false, message: '只能投给已参选的人' };
    e.ballots[v] = c;
    return { ok: true, election: e };
  }

  /* 结算：法定人数与普通投票一致（≥2 人且在线过半）；
   * 票多者胜，平票比信誉等级，再平按 uid 字典序 —— 任何机器算出的结果都一样 */
  function tallyElection(el, rosterSize, now) {
    const e = normalizeElection(el);
    const t = Number(now) || Date.now();
    const joined = Object.keys(e.ballots).length;
    const total = Math.max(1, Number(rosterSize) || 1);
    const need = Math.max(LIMITS.MIN_PARTICIPANTS, Math.ceil(total * LIMITS.QUORUM_RATIO));
    const counts = {};
    for (const c of e.candidates) counts[c.uid] = 0;
    for (const v of Object.keys(e.ballots)) {
      if (counts[e.ballots[v]] != null) counts[e.ballots[v]] += 1;
    }
    if (t < Number(e.endsAt)) {
      return { status: 'open', joined, need, quorum: false, counts, leftMs: Number(e.endsAt) - t };
    }
    const quorum = joined >= need;
    let winner = null;
    if (quorum && e.candidates.length) {
      const sorted = e.candidates
        .slice()
        .sort((a, b) => (counts[b.uid] || 0) - (counts[a.uid] || 0) || b.tier - a.tier || a.uid.localeCompare(b.uid));
      winner = sorted[0].uid;
    }
    return {
      status: quorum && winner ? 'pass' : 'fail',
      joined,
      need,
      quorum,
      counts,
      winner,
      leftMs: 0,
    };
  }

  function settleElection(el, rosterSize, now) {
    const e = normalizeElection(el);
    if (e.status !== 'open') return e;
    const t = tallyElection(e, rosterSize, now);
    if (t.status === 'open') return e;
    e.status = t.status;
    e.result = t.winner || null;
    return e;
  }

  const Gov = {
    TIERS,
    ROLES,
    ROLE_LIST,
    PERMS,
    TYPES,
    LIMITS,
    clampScore,
    tierIndex,
    tierOf,
    tierBadge,
    dayKey,
    normState,
    leftToday,
    bannedUntil,
    canStart,
    newVote,
    cast,
    tally,
    report,
    settle,
    roleOf,
    permsOf,
    hasPerm,
    assign,
    candidates,
    ELECTION_MS,
    normalizeElection,
    newElection,
    campaign,
    castBallot,
    tallyElection,
    settleElection,
  };

  root.PQLegionGov = Gov;
  if (typeof module === 'object' && module.exports) module.exports = Gov;
})(typeof window !== 'undefined' ? window : globalThis);
