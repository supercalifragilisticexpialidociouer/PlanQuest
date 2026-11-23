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
    moderate: { id: 'moderate', name: '管制投票', hostOnly: false, desc: '团长发起、须填理由，副团长投票过半才生效（禁言 1/6/24 小时或移出话题）' },
    evict: { id: 'evict', name: '驱逐提案', hostOnly: true, desc: '全体成员 24 小时内投票，赞成超过 2/3 执行；被驱逐者有 7 天申诉期' },
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
    ABUSE_MAX: 3, // 团长滥用管制 3 次自动解除职务
    APPEAL_MS: 7 * 24 * 3600e3, // 驱逐申诉期 7 天
    APPEAL_CREDIT: 50, // 申诉成功：发起驱逐的团长扣 50 信誉分
    MODERATE_MS: 10 * 60e3, // 管制投票开 10 分钟
    EVICT_MS: 24 * 3600e3, // 驱逐投票开 24 小时
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
      warnings: o.warnings && typeof o.warnings === 'object' ? o.warnings : {},
      watch: o.watch && typeof o.watch === 'object' ? o.watch : {},
      abuse: Number(o.abuse) || 0,
      appeals: o.appeals && typeof o.appeals === 'object' ? o.appeals : {},
      collective: o.collective && typeof o.collective === 'object' ? o.collective : null,
      planBan: Array.isArray(o.planBan) ? o.planBan : [],
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

  /* ---------------- Lv1 劝导权（默认拥有） ----------------
   * 团长对特定成员的聊天「折叠 + 私信提醒」，不公开处刑；被提醒 3 次以上进观察名单，
   * 团长可看其近期发言频率。不能禁言、不能踢人，只能温和点一下。
   */
  const WATCH_AT = 3;

  function fold(state, uid, by, msgId, now) {
    const st = normState(state);
    const id = String(uid || '');
    if (!id) return { ok: false, message: '没有这个人' };
    st.warnings[id] = (Array.isArray(st.warnings[id]) ? st.warnings[id] : []).slice(-49);
    st.warnings[id].push({ at: Number(now) || Date.now(), by: String(by || ''), msgId: String(msgId || '').slice(0, 40) });
    const count = st.warnings[id].length;
    const watch = count >= WATCH_AT;
    if (watch && !st.watch[id]) st.watch[id] = { since: Number(now) || Date.now(), count };
    return { ok: true, count, watch, notice: '你的发言已被军团长标记为「偏离主题」，请注意频道氛围。' };
  }

  function watchOf(state, uid) {
    const st = normState(state);
    const id = String(uid || '');
    return { warns: (st.warnings[id] || []).length, watch: st.watch[id] || null };
  }

  /* 观察名单里看发言频率：按小时分桶 */
  function speechRate(entries, now) {
    const t = Number(now) || Date.now();
    const list = Array.isArray(entries) ? entries : [];
    const buckets = {};
    for (const e of list) {
      const at = Number(e && e.at) || 0;
      if (t - at > 24 * 3600e3) continue;
      const h = Math.floor(at / 3600e3);
      buckets[h] = (buckets[h] || 0) + 1;
    }
    const vals = Object.keys(buckets).map((k) => buckets[k]);
    return { perHour: vals.length ? Math.max(...vals) : 0, recent: list.length };
  }

  /* ---------------- Lv2 管制权（副团长投票过半同意） ----------------
   * 团长对单个成员：禁言 1/6/24 小时，或移出当前话题（不踢团）。
   * 必须填理由，理由进军团日志全员可查；滥用被记录，3 次自动解除团长职务。
   */
  function canStartModerate(state, opts) {
    const o = opts || {};
    if (!o.isHost) return { ok: false, message: '管制权只有团长能发起' };
    const reason = String(o.reason || '').trim();
    if (reason.length < 4) return { ok: false, message: '必须填写理由（至少 4 个字），会记进军团日志' };
    if (!o.hasDeputies) return { ok: false, message: '团里还没有副团长，先投票选出副团长再谈管制' };
    return { ok: true, message: '' };
  }

  /* 副团长投票过半 = 同意票数 * 2 > 副团长人数（且同意 > 反对） */
  function tallyModerate(vote, deputiesCount, now) {
    const v = vote || {};
    const joined = Object.keys(v.votes || {}).length;
    let yes = 0;
    let no = 0;
    for (const k of Object.keys(v.votes || {})) {
      if (v.votes[k] === 'yes') yes += 1;
      else if (v.votes[k] === 'no') no += 1;
    }
    const deps = Math.max(1, Number(deputiesCount) || 1);
    const half = deps % 2 === 0 ? deps / 2 + 1 : Math.ceil(deps / 2); // 过半
    const expired = Number(now) >= Number(v.endsAt || 0);
    const pass = expired && yes >= half && yes > no;
    return { yes, no, joined, need: half, pass, expired, leftMs: Math.max(0, Number(v.endsAt || 0) - Number(now || 0)) };
  }

  /* 滥用记录：管制被 3 人举报作废 / 驱逐申诉成功 → +1；到 3 解除团长职务
   * 注意：abuse 是数字，必须写回调用方传入的原 state（normState 只拷对象不拷数） */
  function abuseTick(state, reason, now) {
    const st = normState(state);
    const n = (Number(st.abuse) || 0) + 1;
    st.log.push({ at: Number(now) || Date.now(), kind: 'abuse', detail: String(reason || '').slice(0, 60), n });
    if (state && typeof state === 'object') state.abuse = n;
    return { n, removed: n >= LIMITS.ABUSE_MAX };
  }

  /* ---------------- Lv3 驱逐权（全员投票 >2/3 + 7 天申诉期） ---------------- */
  function canStartEvict(state, opts) {
    const o = opts || {};
    if (!o.isHost) return { ok: false, message: '驱逐提案只有团长能发起' };
    if (Number(o.rosterSize) < 3) return { ok: false, message: '人太少（<3 人）走不了全员投票，劝退或者忍忍' };
    return { ok: true, message: '' };
  }

  /* 全员 24 小时投票：赞成票 > 全团 2/3 才执行 */
  function tallyEvict(vote, rosterSize, now) {
    const v = vote || {};
    const joined = Object.keys(v.votes || {}).length;
    let yes = 0;
    let no = 0;
    for (const k of Object.keys(v.votes || {})) {
      if (v.votes[k] === 'yes') yes += 1;
      else if (v.votes[k] === 'no') no += 1;
    }
    const total = Math.max(1, Number(rosterSize) || 1);
    const expired = Number(now) >= Number(v.endsAt || 0);
    const pass = expired && yes * 3 > total * 2;
    return { yes, no, joined, need: Math.ceil((total * 2) / 3), pass, expired, leftMs: Math.max(0, Number(v.endsAt || 0) - Number(now || 0)) };
  }

  /* 申诉期：被驱逐者 7 天内可以提交证据；申诉成功恢复身份 + 发起团长扣 50 信誉 */
  function openAppeal(state, uid, now) {
    const st = normState(state);
    const id = String(uid || '');
    if (!id) return { ok: false, message: '没有这个人' };
    if (st.appeals[id] && st.appeals[id].status === 'open') return { ok: false, message: '申诉已经在处理中' };
    st.appeals[id] = {
      at: Number(now) || Date.now(),
      until: (Number(now) || Date.now()) + LIMITS.APPEAL_MS,
      status: 'open',
      evidence: '',
    };
    return { ok: true, appeal: st.appeals[id] };
  }

  function judgeAppeal(state, uid, won, now) {
    const st = normState(state);
    const id = String(uid || '');
    const a = st.appeals[id];
    if (!a || a.status !== 'open') return { ok: false, message: '没有进行中的申诉' };
    a.status = won ? 'won' : 'lost';
    a.judgedAt = Number(now) || Date.now();
    st.log.push({ at: a.judgedAt, kind: 'appeal', detail: `${id} 申诉${won ? '成功' : '失败'}` });
    return { ok: true, won, creditPenalty: won ? LIMITS.APPEAL_CREDIT : 0 };
  }

  /* ---------------- 军团集体任务（团长/投票设置，完成给全团加成，本身算一个任务） ----------------
   * 状态放在治理台账：data.gov.collective = { id, title, target, day, status, progress, contributions }
   * 集体任务完成 → collectiveMetFor 为真 → 全团解锁 L2 狂欢档 + 积分加成（主进程发）。
   */
  function setCollective(state, opts) {
    const st = normState(state);
    const o = opts || {};
    const title = String(o.title || '').trim().slice(0, 40);
    if (!title) return { ok: false, message: '集体任务得有个名字' };
    let target = Math.round(Number(o.target));
    if (!Number.isFinite(target)) target = 90; // 默认基线：出操率 90%
    target = Math.max(50, Math.min(100, target));
    const c = {
      id: 'ct-' + (Number(o.now) || Date.now()).toString(36) + Math.random().toString(36).slice(2, 5),
      title,
      target,
      createdBy: String(o.by || '').slice(0, 40),
      day: String(o.day || dayKey(o.now)),
      status: 'open',
      progress: Math.max(0, Math.min(100, Math.round(Number(o.progress) || 0))),
      contributions: {},
      at: Number(o.now) || Date.now(),
    };
    st.collective = c;
    if (state && typeof state === 'object') state.collective = c; // 写回原 state
    st.log.push({ at: c.at, kind: 'collective', detail: `发起集体任务「${title}」基线 ${target}%` });
    return { ok: true, collective: c };
  }

  /* 成员贡献：0~1，只在涨的时候记（防倒刷） */
  function progressCollective(state, uid, pct) {
    const st = normState(state);
    const c = st.collective;
    if (!c || c.status !== 'open') return { ok: false, message: '当前没有进行中的集体任务' };
    const id = String(uid || '');
    const v = Math.max(0, Math.min(1, Number(pct) || 0));
    if (v <= (Number(c.contributions[id]) || 0)) return { ok: true, unchanged: true };
    c.contributions[id] = v;
    /* 进度 = 全团平均贡献换算成出操率（≥ target 算达标） */
    const ids = Object.keys(c.contributions);
    const avg = ids.reduce((s, k) => s + c.contributions[k], 0) / Math.max(1, ids.length);
    c.progress = Math.round(avg * 100);
    return { ok: true, progress: c.progress, met: c.progress >= c.target };
  }

  function settleCollective(state, now) {
    const st = normState(state);
    const c = st.collective;
    if (!c || c.status !== 'open') return { ok: false, met: false };
    if (c.progress >= c.target) {
      c.status = 'done';
      c.settledAt = Number(now) || Date.now();
      st.log.push({ at: c.settledAt, kind: 'collective', detail: `集体任务「${c.title}」达成 ${c.progress}%，全团加成` });
      return { ok: true, met: true, progress: c.progress, collective: c };
    }
    return { ok: true, met: false, progress: c.progress };
  }

  function collectiveMetFor(state, day) {
    const st = normState(state);
    const c = st.collective;
    return !!(c && c.status === 'done' && (!day || c.day === String(day)));
  }

  function contributionOf(state, uid) {
    const st = normState(state);
    const c = st.collective;
    if (!c) return null;
    const v = Number(c.contributions[String(uid || '')]);
    return Number.isFinite(v) ? v : null;
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
    WATCH_AT,
    fold,
    watchOf,
    speechRate,
    canStartModerate,
    tallyModerate,
    abuseTick,
    canStartEvict,
    tallyEvict,
    openAppeal,
    judgeAppeal,
    setCollective,
    progressCollective,
    settleCollective,
    collectiveMetFor,
    contributionOf,
  };

  root.PQLegionGov = Gov;
  if (typeof module === 'object' && module.exports) module.exports = Gov;
})(typeof window !== 'undefined' ? window : globalThis);
