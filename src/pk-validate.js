/* PlanQuest · PK 数据合法性校验（客户端 + Actions 共用同一份）
 *
 * 为什么单独一份：客户端在「写之前」先自查，Actions 在「匹配之前」再查一遍。
 * 两边用同一套阈值与同一套修复策略，才不会出现「本地觉得没问题、云端判违规」。
 *
 * 修复策略（照需求）：发现越界值 → 回退到「上一次合法值」；没有上一次就丢掉这个字段/这一天，
 * 并记一条告警。绝不因为一条脏数据把整个军团判负 —— 判负靠人（举报）+ 熔断，不靠猜。
 */
'use strict';

const LIMITS = {
  rate: [0, 100], // 出操率百分比
  size: [1, 500], // 军团人数
  rate7: [0, 100], // 近 7 天平均出操率
  focusMin: [0, 1440], // 单日专注分钟（一天最多 24 小时）
  credit: [0, 160], // 信誉分上限（与积分借贷同一套）
  points: [0, 1e7],
  keepDays: 30, // days 里只保留最近 30 天
};

const CODE_RE = /^[A-Za-z0-9_-]{2,16}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const SEASON_RE = /^\d{4}Q[1-4]$/;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/* 取整并夹在区间内；越界时返回 null，交给调用方决定回退还是丢弃 */
function inRange(v, key) {
  const r = LIMITS[key];
  const n = num(v);
  if (!Number.isFinite(n)) return null;
  if (n < r[0] || n > r[1]) return null;
  return Math.round(n);
}

function dayKeyMs(k) {
  const t = Date.parse(String(k) + 'T00:00:00Z');
  return Number.isFinite(t) ? t : NaN;
}

/* ---- 单日出操率表 ---- */
function fixDays(days, lastDays, now, warn) {
  const src = days && typeof days === 'object' ? days : {};
  const prev = lastDays && typeof lastDays === 'object' ? lastDays : {};
  const out = {};
  const cutoff = (Number(now) || Date.now()) - LIMITS.keepDays * 86400e3;
  const keys = Object.keys(src).sort().slice(-LIMITS.keepDays);

  for (const k of keys) {
    const ms = dayKeyMs(k);
    if (!Number.isFinite(ms)) {
      warn('days.key', k, null, '日期格式不对，已丢弃');
      continue;
    }
    if (ms < cutoff) continue; // 太老的直接不要，不算异常

    let v = inRange(src[k], 'rate');
    if (v === null) {
      const was = inRange(prev[k], 'rate');
      v = was;
      if (was !== null) warn('days.' + k, src[k], was, '出操率越界，回退到上次合法值');
      else warn('days.' + k, src[k], null, '出操率越界且无历史值，已丢弃');
      if (v === null) continue;
    }
    out[k] = v;
  }
  return out;
}

/* ---- 军团档案（legions/<code>.json） ---- */
function validateLegionFile(file, lastValid, now) {
  const warnings = [];
  const warn = (field, got, used, reason) => warnings.push({ field, got, used, reason });
  const src = file && typeof file === 'object' ? file : {};
  const prev = lastValid && typeof lastValid === 'object' ? lastValid : {};

  const out = { v: 1 };

  /* 军团码：这是文件名与身份，错了一律不修，直接判无效 */
  const code = String(src.code || '').trim();
  if (!CODE_RE.test(code)) {
    return { ok: false, fatal: '军团码不合法：' + JSON.stringify(String(code).slice(0, 24)), value: null, warnings };
  }
  out.code = code;
  out.name = String(src.name || '军团 ' + code).slice(0, 40);

  const season = String(src.season || '');
  out.season = SEASON_RE.test(season) ? season : String(prev.season || '');
  if (!SEASON_RE.test(season) && out.season) warn('season', season, out.season, '赛季格式不对，回退');

  const week = String(src.week || '');
  out.week = WEEK_RE.test(week) ? week : String(prev.week || '');
  if (!WEEK_RE.test(week) && out.week) warn('week', week, out.week, '周起始日格式不对，回退');

  const size = inRange(src.size, 'size');
  if (size === null) {
    const was = inRange(prev.size, 'size');
    out.size = was;
    if (was !== null) warn('size', src.size, was, '人数越界，回退到上次合法值');
    else warn('size', src.size, null, '人数越界且无历史值');
  } else out.size = size;

  const rate7 = inRange(src.rate7, 'rate7');
  if (rate7 === null) {
    const was = inRange(prev.rate7, 'rate7');
    out.rate7 = was;
    if (was !== null) warn('rate7', src.rate7, was, '七日平均出操率越界，回退到上次合法值');
  } else out.rate7 = rate7;

  out.days = fixDays(src.days, prev.days, now, warn);
  out.opponent = CODE_RE.test(String(src.opponent || '')) ? String(src.opponent) : '';
  out.result = src.result && typeof src.result === 'object'
    ? { win: !!src.result.win, draw: !!src.result.draw, my: num(src.result.my) || 0, opp: num(src.result.opp) || 0, at: num(src.result.at) || 0 }
    : null;
  out.updated = num(src.updated) || 0;

  return { ok: warnings.length === 0, fatal: '', value: out, warnings };
}

/* ---- 成员摘要（军团内部聚合用，含专注与信誉） ----
 * 军团只在局域网/网格里传这个，但 Actions 侧也会用它校验「上报的军团数字是否离谱」。
 */
function validateBundle(bundle, lastValid, now) {
  const warnings = [];
  const warn = (field, got, used, reason) => warnings.push({ field, got, used, reason });
  const src = bundle && typeof bundle === 'object' ? bundle : {};
  const prev = lastValid && typeof lastValid === 'object' ? lastValid : {};
  const out = {};

  out.day = DAY_RE.test(String(src.day || '')) ? String(src.day) : String(prev.day || '');
  const keep = ['checked', 'force', 'neg'];
  for (const k of keep) out[k] = !!src[k];

  const focus = inRange(src.focusMin, 'focusMin');
  if (focus === null && src.focusMin != null) {
    const was = inRange(prev.focusMin, 'focusMin');
    out.focusMin = was;
    warn('focusMin', src.focusMin, was, was === null ? '专注分钟超过 1440 且无历史值' : '专注分钟超过 1440，回退到上次合法值');
  } else if (focus !== null) out.focusMin = focus;

  const credit = inRange(src.credit, 'credit');
  if (credit === null && src.credit != null) {
    const was = inRange(prev.credit, 'credit');
    out.credit = was;
    warn('credit', src.credit, was, was === null ? '信誉分超过 160 且无历史值' : '信誉分超过 160，回退到上次合法值');
  } else if (credit !== null) out.credit = credit;

  return { ok: warnings.length === 0, value: out, warnings };
}

/* 一条记录脏到什么程度需要被「单独盯上」 */
function isSuspicious(res) {
  return !!(res && Array.isArray(res.warnings) && res.warnings.length >= 3);
}

function summarize(warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (!list.length) return '';
  return list.map((w) => `${w.field}=${JSON.stringify(w.got)}→${JSON.stringify(w.used)}（${w.reason}）`).join('；');
}

module.exports = {
  LIMITS,
  CODE_RE,
  DAY_RE,
  WEEK_RE,
  SEASON_RE,
  inRange,
  fixDays,
  validateLegionFile,
  validateBundle,
  isSuspicious,
  summarize,
};
