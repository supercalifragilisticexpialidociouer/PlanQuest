/* PlanQuest · 好友区（F0 未结缘 / F1 搭子档 / F2 战友档）
 *
 * 设计原则（和军团那套一致）：
 *   1. 判定全部是纯函数：谁在哪个档、今天还能不能发，任何一端算出来都一样。
 *   2. 不能主动搜陌生人私信 —— F0 就是一张白纸，想结缘只能走三条正路：
 *      双人自习室（同一房间打过卡）/ 对赌契约（互为监督人）/ 问答申请（他律那套门禁）。
 *      防的是把好友区做成约炮和微商的入口。
 *   3. F1 搭子档：纯文本 + 房间/军团/主页链接，24 小时焚毁，一天 20 条；
 *      双方今日完成率 ≥50% 才能发，两边都摆烂 → 输入框灰掉（界面拿 reason 提示「先各自干活」）。
 *   4. F2 战友档：双方都完成当日 100% → 次日升级；额度提到 50 条，能发打卡截图互证、
 *      能开 1v1 语音监督房；任一方断勤退回 F1，连续 3 天断勤自动解缘回 F0。
 */
'use strict';

(function (root) {
  const LIMITS = {
    F1_DAILY: 20, // F1 每天对同一人最多 20 条
    F2_DAILY: 50, // F2 提到 50 条
    RATE_GATE: 50, // 双方今日完成率门槛（%）
    BURN_MS: 24 * 3600e3, // 消息 24 小时自动焚毁
    SLUMP_LIMIT: 3, // 连续断勤 3 天 → 解缘回 F0
    MAX_MSG: 500, // 单条上限
    MAX_LOG: 200, // 本地缓存的消息条数（焚毁之上再兜一层）
    GATE_MIN: 1, // 问答门禁：至少 1 题
    GATE_MAX: 5, // 最多 5 题
    MAX_FRIENDS: 20, // 好友上限（防好友区变成通讯录）
  };

  const TIERS = {
    0: { key: 0, name: '未结缘', desc: '还只是陌生人：不能私信，先一起去自习室/契约/答题结缘' },
    1: { key: 1, name: '搭子档', desc: '纯文本+软件内链接 · 24h 焚毁 · 每日 20 条 · 双方完成率≥50% 才能发' },
    2: { key: 2, name: '战友档', desc: '50 条/天 · 打卡截图互证 · 计划包（二次确认）· 1v1 语音监督房' },
  };

  function dayKey(now) {
    const d = new Date(Number(now) || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function nextDayKey(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    d.setDate(d.getDate() + 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ---------------- 结缘 ----------------
   * 三条正路：room（双人自习室同房打卡过）/ contract（对赌契约互为监督人）/ gate（问答申请）
   * via 记录在档位历史里，界面能看出「这人是哪条路上认识的」。
   */
  const VIAS = { room: '双人自习室', contract: '对赌契约', gate: '问答申请' };

  function bond(uid, alias, via, now) {
    const id = String(uid || '').slice(0, 40);
    if (!id) return { ok: false, message: '没有这个人' };
    if (!VIAS[via]) return { ok: false, message: '只能通过双人自习室 / 对赌契约 / 问答申请结缘' };
    return {
      ok: true,
      friend: {
        uid: id,
        alias: String(alias || '搭子').slice(0, 12),
        tier: 1,
        via,
        since: Number(now) || Date.now(),
        quota: { day: '', n: 0 },
        theirQuota: { day: '', n: 0 }, // 对方发给我的计数（双方各自也有限额）
        promoteDay: '', // 双方全勤的那天 → 次日升级 F2
        slump: 0, // 连续断勤天数（F2 退 F1 后继续累计，到 3 解缘）
        fullStreak: 0, // 连续双方全勤天数（展示用）
      },
    };
  }

  function unbond(f) {
    /* 解缘：不留尸体，直接回到 F0（调用方负责把 friends[uid] 删掉并记一条日志） */
    return { ok: true, tier: 0 };
  }

  /* ---------------- 问答申请（他律门禁） ----------------
   * 申请者回答对方出的问题，全对才算过 —— 问题由申请发起方的对象出，
   * 出题人想考察什么自己定（比如「我们的房间码是多少」），防陌生人海投。
   */
  function makeGate(peerUid, peerAlias, questions, now) {
    const uid = String(peerUid || '').slice(0, 40);
    if (!uid) return { ok: false, message: '没有这个人' };
    const qs = (Array.isArray(questions) ? questions : [])
      .map((x) => ({
        q: String((x && x.q) || '').trim().slice(0, 30),
        a: String((x && x.a) || '').trim().slice(0, 20),
      }))
      .filter((x) => x.q && x.a);
    if (qs.length < LIMITS.GATE_MIN || qs.length > LIMITS.GATE_MAX) {
      return { ok: false, message: `问题要 ${LIMITS.GATE_MIN}~${LIMITS.GATE_MAX} 题，每题都要有答案` };
    }
    return {
      ok: true,
      gate: {
        id: 'g-' + (Number(now) || Date.now()).toString(36) + Math.random().toString(36).slice(2, 5),
        uid,
        alias: String(peerAlias || '').slice(0, 12),
        questions: qs,
        answers: [],
        status: 'open', // open → pass | fail
        at: Number(now) || Date.now(),
      },
    };
  }

  const normAns = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[\s\-_·、,，。.!！?？'"“”‘’()（）]+/g, '');

  function answerGate(gate, answers) {
    const g = gate || {};
    if (g.status !== 'open') return { ok: false, message: '这份申请已经处理过了' };
    const list = Array.isArray(answers) ? answers : [];
    let correct = 0;
    g.questions.forEach((q, i) => {
      if (normAns(list[i]) === normAns(q.a)) correct += 1;
    });
    g.answers = list.map((a) => String(a || '').slice(0, 20));
    const pass = correct === g.questions.length; // 全对才放行
    g.status = pass ? 'pass' : 'fail';
    g.correct = correct;
    return { ok: true, pass, correct, total: g.questions.length };
  }

  /* ---------------- 每日额度 ---------------- */

  function quotaLeft(f, now, mine) {
    const q = (mine === false ? (f || {}).theirQuota : (f || {}).quota) || {};
    const day = dayKey(now);
    const used = q.day === day ? Number(q.n) || 0 : 0;
    const cap = (Number((f || {}).tier) === 2 ? LIMITS.F2_DAILY : LIMITS.F1_DAILY);
    return Math.max(0, cap - used);
  }

  function tickQuota(f, now, mine) {
    const key = mine === false ? 'theirQuota' : 'quota';
    const day = dayKey(now);
    const q = f[key] && f[key].day === day ? f[key] : { day, n: 0 };
    q.n = (Number(q.n) || 0) + 1;
    f[key] = q;
    return f;
  }

  /* ---------------- 能不能发 ----------------
   * kind: text | shot(打卡截图,F2) | plan(计划包,F2) | image | file | exturl | emoji
   * rates: { myRate, peerRate } 0~100；null/undefined 视为「还没打卡，按 0 算」
   * 返回 { ok, reason } —— 界面直接把 reason 灰在输入框下面。
   */
  function canSend(f, now, opts) {
    const o = opts || {};
    const tier = Number((f || {}).tier) || 0;
    if (tier === 0) return { ok: false, reason: '还没结缘：先一起去双人自习室、立对赌契约，或通过问答申请' };
    const myRate = Number(o.myRate);
    const peerRate = Number(o.peerRate);
    const my = Number.isFinite(myRate) ? myRate : 0;
    const peer = Number.isFinite(peerRate) ? peerRate : 0;
    if (my < LIMITS.RATE_GATE || peer < LIMITS.RATE_GATE) {
      return { ok: false, reason: '先各自干活：双方今日完成率都要 ≥50% 才能私聊', gate: true };
    }
    if (quotaLeft(f, now, true) <= 0) {
      return { ok: false, reason: `今天对 TA 的额度用完了（${tier === 2 ? LIMITS.F2_DAILY : LIMITS.F1_DAILY} 条/天）` };
    }
    const kind = String(o.kind || 'text');
    if (kind === 'shot' && tier < 2) return { ok: false, reason: '打卡截图互证是战友档（F2）权限，先一起全勤升级' };
    if (kind === 'plan' && tier < 2) return { ok: false, reason: '计划包转发是战友档（F2）权限，导入前还要二次确认' };
    if (kind === 'image' || kind === 'file') return { ok: false, reason: '好友私聊禁图片和文件，防微商入口' };
    if (kind === 'exturl') return { ok: false, reason: '外部链接一律不放行，软件内的链接才能点' };
    if (kind === 'emoji' && tier < 2) return { ok: false, reason: '表情包是战友档（F2）权限' };
    return { ok: true, reason: '' };
  }

  function send(f, now, opts) {
    const c = canSend(f, now, opts);
    if (!c.ok) return c;
    tickQuota(f, now, true);
    return { ok: true };
  }

  /* ---------------- 消息焚毁 ---------------- */

  function makeMsg(fromUid, fromAlias, text, at, kind, attach) {
    const t = Number(at) || Date.now();
    const out = {
      id: `${String(fromUid || '').slice(0, 12)}-${t.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      uid: String(fromUid || '').slice(0, 40),
      alias: String(fromAlias || '').slice(0, 12),
      text: String(text || '').slice(0, LIMITS.MAX_MSG),
      at: t,
      kind: String(kind || 'text'),
      burnAt: t + LIMITS.BURN_MS,
    };
    if (attach && typeof attach === 'object') out.attach = attach;
    return out;
  }

  function burnLeft(msg, now) {
    return Math.max(0, (Number((msg || {}).burnAt) || 0) - (Number(now) || Date.now()));
  }

  /* 24 小时一到就地焚毁：返回还活着的消息（倒序截到 MAX_LOG） */
  function pruneBurned(msgs, now) {
    const t = Number(now) || Date.now();
    const live = (Array.isArray(msgs) ? msgs : [])
      .filter((m) => m && (Number(m.burnAt) || 0) > t)
      .slice(-LIMITS.MAX_LOG);
    return live;
  }

  /* ---------------- 每日结算（升级 / 降档 / 解缘） ----------------
   * full = 双方今日都完成 100%。调用方（主进程 0 点定时器）每天调一次。
   * 顺序：先处理「昨天记下的升级」，再按今天表现记档。
   */
  function settleDay(f, day, full) {
    const fr = f || {};
    const d = String(day || '');
    /* 晋升兑现：昨天双方全勤 → 今天升级 F2 */
    if (fr.promoteDay && d >= fr.promoteDay && fr.tier === 1) {
      fr.tier = 2;
      fr.promoteDay = '';
      fr.since2 = d;
    }
    if (full) {
      fr.slump = 0;
      fr.fullStreak = (Number(fr.fullStreak) || 0) + 1;
      if (fr.tier === 1 && !fr.promoteDay) fr.promoteDay = nextDayKey(d);
      return { tier: fr.tier, note: fr.tier === 2 ? '保持战友档' : fr.tier === 1 ? '双方全勤，明天升战友档' : '' };
    }
    fr.fullStreak = 0;
    fr.promoteDay = '';
    if (fr.tier === 2) {
      fr.slump = (Number(fr.slump) || 0) + 1;
      fr.tier = 1;
      if (fr.slump >= LIMITS.SLUMP_LIMIT) {
        fr.tier = 0;
        return { tier: 0, unbond: true, note: '连续 3 天断勤，自动解缘' };
      }
      return { tier: 1, note: '任一方断勤，退回搭子档' };
    }
    if (fr.tier === 1 && fr.slump > 0) {
      fr.slump = (Number(fr.slump) || 0) + 1;
      if (fr.slump >= LIMITS.SLUMP_LIMIT) {
        fr.tier = 0;
        return { tier: 0, unbond: true, note: '连续 3 天断勤，自动解缘' };
      }
    }
    return { tier: fr.tier, note: '' };
  }

  function tierText(f) {
    const t = Number((f || {}).tier) || 0;
    return TIERS[t] ? TIERS[t].name : TIERS[0].name;
  }

  /* ---------------- 任务排行（好友区排行榜） ----------------
   * 我和所有搭子按今日完成率排；对方完成率是 TA 自己报/同步来的。
   * 平分时按昵称字典序，保证所有人算出同一个榜。
   */
  function ranking(friends, myRate, myAlias) {
    const rows = Object.entries(friends || {}).map(([uid, f]) => ({
      uid,
      alias: (f && f.alias) || '搭子',
      tier: Number((f && f.tier) || 1),
      rate: Math.max(0, Math.min(100, Math.round(Number((f && f.peerRate) || 0)))),
      via: (f && f.via) || '',
    }));
    rows.push({
      uid: 'me',
      alias: myAlias || '我',
      tier: 1,
      rate: Math.max(0, Math.min(100, Math.round(Number(myRate) || 0))),
      isMe: true,
    });
    rows.sort((a, b) => b.rate - a.rate || String(a.alias).localeCompare(String(b.alias)));
    rows.forEach((r, i) => (r.rank = i + 1));
    return rows;
  }

  /* ---------------- 互相契约（搭子对赌） ----------------
   * 双方各押一笔积分，约定 N 天内谁断勤谁按天扣；全勤到期全退。
   * 本机只记账自己的这份；对方那份在 TA 的电脑上按同一份规则算。
   */
  const PACT = {
    MIN_DEPOSIT: 5,
    MAX_DEPOSIT: 200,
    MIN_DAYS: 3,
    MAX_DAYS: 30,
  };

  function shiftDay(day, n) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    d.setDate(d.getDate() + (Number(n) || 0));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function makePact(f, opts, now) {
    if (!f) return { ok: false, message: '还没结缘，立不了契约' };
    if (f.pact && f.pact.status === 'active') return { ok: false, message: '已经有生效中的契约，先结算再立新的' };
    const deposit = Math.max(PACT.MIN_DEPOSIT, Math.min(PACT.MAX_DEPOSIT, Math.round(Number((opts || {}).deposit) || 0)));
    if (!Number((opts || {}).deposit)) return { ok: false, message: '要填押金（5~200 分）' };
    const days = Math.max(PACT.MIN_DAYS, Math.min(PACT.MAX_DAYS, Math.round(Number((opts || {}).days) || 7)));
    const t = Number(now) || Date.now();
    f.pact = {
      deposit,
      days,
      startDay: dayKey(t),
      endDay: shiftDay(dayKey(t), days),
      status: 'active',
      missed: 0,
      log: [],
    };
    return { ok: true, pact: f.pact };
  }

  /* 每日记一笔：done = 当天全勤。到期自动结算。
   * penalty：每漏一天扣「押金 / 天数」向上取整；全勤到期全退（罚 0）。
   */
  function pactTick(f, day, done, now) {
    const p = f && f.pact;
    if (!p || p.status !== 'active') return { ok: false };
    const d = String(day || dayKey(now));
    if (p.log.some((x) => x && x.day === d)) return { ok: true, unchanged: true, missed: p.missed };
    p.log.push({ day: d, done: !!done });
    if (!done) p.missed = (Number(p.missed) || 0) + 1;
    /* 记满约定天数（或跨过 endDay）即到期结算 */
    if (p.log.length >= Math.max(1, p.days) || d >= p.endDay) {
      p.status = 'done';
      const per = Math.ceil(p.deposit / Math.max(1, p.days));
      const penalty = Math.min(p.deposit, per * (Number(p.missed) || 0));
      const pass = (Number(p.missed) || 0) === 0;
      return { ok: true, ended: true, pass, missed: p.missed, penalty, refund: p.deposit - penalty };
    }
    return { ok: true, ended: false, missed: p.missed };
  }

  /* 手动提前结算（中途散伙）：漏的天照样扣 */
  function pactSettle(f, now) {
    const p = f && f.pact;
    if (!p || p.status !== 'active') return { ok: false, message: '没有生效中的契约' };
    p.status = 'done';
    const per = Math.ceil(p.deposit / Math.max(1, p.days));
    const penalty = Math.min(p.deposit, per * (Number(p.missed) || 0));
    return { ok: true, ended: true, pass: (Number(p.missed) || 0) === 0, missed: p.missed, penalty, refund: p.deposit - penalty, early: true };
  }

  /* ---------------- 未完成自动提醒对方 ----------------
   * 每晚 21 点后，如果自己还有没做完的任务，给每个搭子发一条免费提醒
   *（不计额度、不占 20/50 条；照样 24h 焚毁）。每天每人最多一条。
   */
  const REMIND_HOUR = 21;

  function remindText(left) {
    return `⏰ 搭子提醒：你今天还有 ${left} 项任务没打卡。我先替 TA 喊一嗓子——现在补上还来得及。`;
  }

  function shouldRemind(f, now, leftCount) {
    if (!f || (Number(f.tier) || 0) < 1) return false;
    const left = Number(leftCount) || 0;
    if (left <= 0) return false;
    const t = Number(now) || Date.now();
    const d = new Date(t);
    if (d.getHours() < REMIND_HOUR) return false;
    const day = dayKey(t);
    if (f.lastRemindDay === day) return false;
    f.lastRemindDay = day;
    return true;
  }

  const API = {
    LIMITS,
    TIERS,
    VIAS,
    PACT,
    REMIND_HOUR,
    dayKey,
    nextDayKey,
    shiftDay,
    bond,
    unbond,
    makeGate,
    answerGate,
    quotaLeft,
    tickQuota,
    canSend,
    send,
    makeMsg,
    burnLeft,
    pruneBurned,
    settleDay,
    tierText,
    normAns,
    ranking,
    makePact,
    pactTick,
    pactSettle,
    remindText,
    shouldRemind,
  };

  root.PQFriend = API;
  if (typeof module === 'object' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
