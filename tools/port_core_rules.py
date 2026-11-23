# -*- coding: utf-8 -*-
"""把桌面版的新规则移植到 web / android 两端：
1. 计划触发时机 when='boot'（开机时）
2. 积分只跟「计划里新放行非白名单普通软件」挂钩（其余一律不扣分）
3. 快照暴露 activeNow（供动态图标判断「有任务进行中」）
"""
import io, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGETS = [
    os.path.join(ROOT, 'web', 'core', 'pq-core.js'),
    os.path.join(ROOT, 'android-app', 'www', 'core', 'pq-core.js'),
]

def rep(s, old, new, tag):
    if old not in s:
        print('  MISS  ' + tag)
        return s, False
    print('  OK    ' + tag)
    return s.replace(old, new, 1), True

for path in TARGETS:
    print('=== ' + os.path.relpath(path, ROOT))
    s = io.open(path, encoding='utf-8').read()
    ok = True

    # 1) 时间工具后面追加 when 支持
    s, r = rep(s,
        """const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

const CLOSE_PENALTY = 10;""",
        """const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

/* 计划触发时机：p.when = 'time'（默认，定时）| 'boot'（开机 / 打开应用时） */
let bootMinutes = null;
const REMIND_WINDOW_MIN = 45;
const planStartMin = (p) => (p && p.when === 'boot' ? (bootMinutes == null ? nowMinutes() : bootMinutes) : minutesOf(p.time));
const hasActivePlanNow = () => {
  const now = nowMinutes();
  return plansForDate(dateKey()).some((p) => {
    const m = planStartMin(p);
    return now >= m && now <= m + REMIND_WINDOW_MIN;
  });
};

const CLOSE_PENALTY = 10;
const PLAN_PROC_PENALTY = 10;""", '时间工具 + planStartMin')
    ok &= r

    # 2) 计划排序按触发时刻
    s, r = rep(s,
        ".sort((a, b) => minutesOf(a.time) - minutesOf(b.time));",
        ".sort((a, b) => planStartMin(a) - planStartMin(b));", 'plansForDate 排序')
    ok &= r

    # 3) 今日计划「错过」判定
    s, r = rep(s,
        "const late = nowMinutes() > minutesOf(p.time) + 45;",
        "const late = nowMinutes() > planStartMin(p) + 45;", 'todayPlans late 判定')
    ok &= r

    # 4) savePlan：写入 when + 新扣分规则
    s, r = rep(s,
        """    time, days,
    points: Math.max(5, Math.min(200, Number(plan?.points) || 20)),""",
        """    time, days,
    when: plan?.when === 'boot' ? 'boot' : 'time',
    points: Math.max(5, Math.min(200, Number(plan?.points) || 20)),""", 'savePlan 写入 when')
    ok &= r

    s, r = rep(s,
        """  const idx = data.plans.findIndex((p) => p.id === clean.id);
  if (idx >= 0) data.plans[idx] = clean; else data.plans.push(clean);
  let deducted = isEdit ? 10 : 0;
  if (!isEdit && allowProcs.length) deducted += 10;
  if (deducted) setProfilePoints((data.profile.points || 0) - deducted); // 可扣成负分
  saveNow();
  return { ok: true, id: clean.id, deducted, rejected };""",
        """  /* 积分只跟「计划里新放行非白名单普通软件」挂钩：
     改标题/时间/星期、只放行白名单软件 —— 都不扣分 */
  const prevPlan = isEdit ? data.plans.find((p) => p.id === clean.id) : null;
  const prevSet = new Set(((prevPlan && prevPlan.allowProcs) || []).map((x) => String(x).toLowerCase()));
  const normalAdded = allowProcs.filter((n) => {
    if (prevSet.has(n)) return false;
    return !(data.guardian.whitelist || []).some((w) => String(w).toLowerCase().replace(/\\.exe$/, '') === n);
  });
  const idx = data.plans.findIndex((p) => p.id === clean.id);
  if (idx >= 0) data.plans[idx] = clean; else data.plans.push(clean);
  const deducted = normalAdded.length ? PLAN_PROC_PENALTY : 0;
  if (deducted) setProfilePoints((data.profile.points || 0) - deducted); // 可扣成负分
  saveNow();
  return { ok: true, id: clean.id, deducted, rejected, normalProcs: normalAdded };""", 'savePlan 新扣分规则')
    ok &= r

    # 5) deletePlan 不扣分
    s, r = rep(s,
        """  let deducted = 0;
  if (existed && !isTemp) {
    deducted = CLOSE_PENALTY;
    setProfilePoints((data.profile.points || 0) - CLOSE_PENALTY); // 可扣成负分
  }""",
        """  // 删除计划不扣分（积分只跟「计划放行非白名单普通软件」挂钩）
  const deducted = 0;""", 'deletePlan 不扣分')
    ok &= r

    # 6) togglePlan 不扣分
    s, r = rep(s,
        """function togglePlan(id, enabled) {
  const p = data.plans.find((x) => x.id === id);
  let deducted = 0;
  if (p) {
    const wasOn = p.enabled !== false;
    const turningOff = wasOn && enabled === false;
    const turningOn = !wasOn && enabled === true;
    p.enabled = !!enabled;
    if ((turningOff || turningOn) && !p.temp) {
      deducted = CLOSE_PENALTY;
      setProfilePoints((data.profile.points || 0) - CLOSE_PENALTY); // 可扣成负分
    }
  }
  saveNow();
  return { ok: true, deducted };
}""",
        """function togglePlan(id, enabled) {
  const p = data.plans.find((x) => x.id === id);
  if (p) p.enabled = !!enabled;
  // 暂停 / 重新启用都不扣分
  saveNow();
  return { ok: true, deducted: 0 };
}""", 'togglePlan 不扣分')
    ok &= r

    # 7) 提醒 tick 用 planStartMin
    s, r = rep(s,
        "if (now < minutesOf(p.time) || now > minutesOf(p.time) + 45) continue;",
        "if (now < planStartMin(p) || now > planStartMin(p) + 45) continue;", 'reminderTick 基准')
    ok &= r

    # 8) 快照暴露 activeNow
    s, r = rep(s,
        """    todayPlans,
    todayPoints: todayPoints(today),""",
        """    todayPlans,
    activeNow: hasActivePlanNow(),
    todayPoints: todayPoints(today),""", 'snapshot.activeNow')
    ok &= r

    # 9) 初始化时记录启动分钟（用于「开机时」计划）
    s, r = rep(s,
        """/* ---------------- 初始化 ---------------- */
loadData();""",
        """/* ---------------- 初始化 ---------------- */
loadData();
bootMinutes = nowMinutes();""", '初始化 bootMinutes')
    ok &= r

    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('  -> ' + ('完成' if ok else '有未匹配项，需要人工检查'))
