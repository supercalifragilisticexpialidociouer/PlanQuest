/* contract-fine.js —— 契约项目罚金计算（双端 UMD 同源，无 DOM）
 *
 * 硬规则（产品口径）：
 *  1. 只有「当天有契约任务可做（due > 0）并且没全做完（done < due）」才扣钱。
 *     没有任务的那天，一分钱都不扣——不能因为项目在跑就白扣。
 *  2. 应扣 = 每日罚金上限 × (100 − 完成度)% ，向上取整到至少 1 元；
 *     全部完成（done === due）不扣。
 *  3. 当天没结束前，罚金是「实时预估」：任务还能补做，所以金额会随打卡下降；
 *     第二天结算后才写入账本，不重复计。
 *  4. 已标记「这笔已交」的日期不进未交金额。
 *
 * 供 src/main.js（桌面主进程）与 web/core/pq-core.js（Web/安卓）共用。
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.PQContractFine = mod;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d || 0); }

  /* 某天的罚金：due=任务数、done=已完成数、stake=每日罚金上限 */
  function calc(stake, due, done) {
    var cap = Math.max(0, num(stake, 0));
    var total = Math.max(0, Math.floor(num(due, 0)));
    var finished = Math.max(0, Math.min(total, Math.floor(num(done, 0))));
    if (!total) return { due: 0, done: 0, pct: null, owe: 0, fine: false };
    var pct = Math.round((finished / total) * 100);
    var owe = pct < 100 ? Math.max(1, Math.round((cap * (100 - pct)) / 100)) : 0;
    return { due: total, done: finished, pct: pct, owe: owe, fine: owe > 0 };
  }

  /* 账本里已结算的累计金额（settlements: { date: { owe } }） */
  function settledTotal(settlements, paid, onlyUnpaid) {
    var sum = 0;
    if (!settlements || typeof settlements !== 'object') return 0;
    for (var k in settlements) {
      if (!Object.prototype.hasOwnProperty.call(settlements, k)) continue;
      var s = settlements[k];
      if (!s || !num(s.owe, 0)) continue;
      if (onlyUnpaid && paid && paid[k]) continue;
      sum += num(s.owe, 0);
    }
    return sum;
  }

  /* 把「今天实时应扣」并进累计：今天未结算且未标记已交时才计入，避免重复 */
  function combine(settlements, paid, todayKey, todayCalc, todaySettled) {
    var settled = settledTotal(settlements, paid, false);
    var unpaid = settledTotal(settlements, paid, true);
    var t = todayCalc || calc(0, 0, 0);
    var paidToday = !!(paid && todayKey && paid[todayKey]);
    var todayOwe = (!todaySettled && !paidToday) ? num(t.owe, 0) : 0;
    return {
      settled: settled,
      todayOwe: todayOwe,
      total: settled + todayOwe,
      unpaid: unpaid + todayOwe,
      fineToday: todayOwe > 0,
    };
  }

  /* ---------- 契约任务「创建后不可修改」 ---------- *
   * 判断依据必须是「账本里已存在的原计划」，不能用调用方传来的新 payload：
   * 否则把 contract 字段抹掉就能绕过锁定。
   * 停用也算修改——停掉的任务不会进 contractTasksForDate，等于变相逃罚金。
   * 删除仍是另一套规则（到期前不可删、到期后可删），由各端 plan:delete 自己管。
   */
  function isContractTask(p) { return !!(p && p.contract); }

  function editLock(p, projects) {
    if (!isContractTask(p)) return { locked: false, reason: '' };
    var end = '';
    if (Array.isArray(projects)) {
      for (var i = 0; i < projects.length; i++) {
        var c = projects[i];
        if (c && c.id === p.contract) { end = c.endDate || c.end || ''; break; }
      }
    }
    return {
      locked: true,
      reason: '契约任务创建后不可修改' + (end ? '（' + end + ' 到期）' : '')
        + '。立下的约，岂能由你随手涂改？到期前也不可删除。',
    };
  }

  return {
    calc: calc, settledTotal: settledTotal, combine: combine,
    isContractTask: isContractTask, editLock: editLock,
  };
});
