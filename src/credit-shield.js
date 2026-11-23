/* PlanQuest · 新手保护罩（梯度递减，不是开关）
 *
 * 为什么不做成「前 7 天全免」：那等于告诉用户第 8 天开始突然全责，
 * 体验上是断崖；而且前 7 天会养成坏习惯，第 8 天一次性崩。
 *
 * 梯度：
 *   第 1 天     完全保护   只提醒，不扣分。提醒里写清「下次再犯就会扣分」。
 *   第 2-3 天   轻度保护   扣分按 50% 算，并明确告知「下次全额」。
 *   第 4-7 天   过渡期     全额扣分，但信誉分下限为 0（扣不到负数）。
 *   第 8 天起   正常规则   全额扣分，可以为负，进入负分缓冲机制。
 *
 * 只作用于「扣分」，加分不受影响 —— 保护罩是防误伤，不是防成长。
 */
'use strict';

const DAY = 86400e3;

const STAGES = [
  { key: 'full', label: '完全保护', factor: 0, floor: 0, until: 1 },
  { key: 'half', label: '轻度保护', factor: 0.5, floor: 0, until: 3 },
  { key: 'soft', label: '过渡期', factor: 1, floor: 0, until: 7 },
  { key: 'normal', label: '正常规则', factor: 1, floor: null, until: Infinity },
];

/* elapsedDays: 0 = 第 1 天 */
function stageOf(elapsedDays) {
  const d = Math.max(0, Math.floor(Number(elapsedDays) || 0));
  for (const s of STAGES) if (d < s.until) return s;
  return STAGES[STAGES.length - 1];
}

function shieldOf(firstAt, now) {
  const t1 = Number(now) || Date.now();
  const raw = Number(firstAt);
  const t0 = Number.isFinite(raw) && firstAt != null ? raw : t1;
  const elapsed = Math.max(0, (Number(now) || Date.now()) - t0) / DAY;
  const day = Math.floor(elapsed) + 1; // 展示用：第几天
  const s = stageOf(Math.floor(elapsed));
  return {
    day,
    key: s.key,
    label: s.label,
    factor: s.factor,
    floor: s.floor,
    warnOnly: s.factor === 0,
    leftDays: Math.max(0, 8 - day),
  };
}

/* 把一次扣分套上保护罩：返回真正生效的扣分与提示文案 */
function applyPenalty(delta, shield) {
  const d = Number(delta) || 0;
  if (d >= 0) return { delta: d, note: '' };
  const s = shield || shieldOf(Date.now(), Date.now());
  const scaled = -Math.max(0, Math.round(Math.abs(d) * s.factor));
  if (s.factor === 0) {
    return {
      delta: 0,
      note: '第 1 天只提醒不扣分。这条规则是为了保护你的专注力，下次再犯就会扣分了。',
    };
  }
  if (s.factor < 1) {
    return {
      delta: scaled,
      note: `新手保护中：这次只扣 ${Math.abs(scaled)} 分（正常 ${Math.abs(d)} 分的一半），下次将全额扣分。`,
    };
  }
  if (s.floor != null) {
    return { delta: scaled, floor: s.floor, note: '过渡期：信誉分最低到 0，不会变成负数。' };
  }
  return { delta: scaled, note: '' };
}

function explain() {
  return STAGES.map((s) =>
    s.key === 'full' ? `第 1 天 · ${s.label}：只提醒，不扣分`
      : s.key === 'half' ? `第 2-3 天 · ${s.label}：扣 50%，并提示下次全额`
        : s.key === 'soft' ? `第 4-7 天 · ${s.label}：全额扣分，下限 0`
          : `第 8 天起 · ${s.label}：全额扣分，可为负`
  );
}

module.exports = { STAGES, stageOf, shieldOf, applyPenalty, explain };
