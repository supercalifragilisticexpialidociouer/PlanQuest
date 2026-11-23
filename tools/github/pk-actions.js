#!/usr/bin/env node
/* PlanQuest · PK 匹配（GitHub Actions 侧）
 *
 * 放在私有布告栏仓库里跑，每次匹配前先做三件事：
 *   1. 验签：legions/<code>.json 必须由声明的那把公钥签过，内容被改过就剔除；
 *   2. 校验：出操率 0~100、人数 1~500、专注 ≤1440、信誉 ≤160 …
 *      越界就回退到「上一次合法值」（取 git 历史里的上一版），并记告警；
 *   3. 配对：同赛季、同周、三天内活跃的军团，按近 7 天出操率相邻配对。
 *
 * 输出：
 *   results/<周一>/pairing.json   { pairs, bye, anomalies, fixed, week, at }
 *   logs/<日期>.json              当天所有修复与告警（追加）
 *
 * 用法（仓库根目录）：
 *   GITHUB_REPOSITORY 由 Actions 自动注入；本地跑可设 LEGIONS_DIR=./legions
 *   node .github/scripts/pk-actions.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const V = require('./pk-validate.js');
const signer = require('./pk-sign.js');

const DAY = 86400e3;
const LEGIONS_DIR = process.env.LEGIONS_DIR || 'legions';
const RESULTS_DIR = process.env.RESULTS_DIR || 'results';
const LOGS_DIR = process.env.LOGS_DIR || 'logs';
const FRESH_MS = 3 * DAY;

function ymd(d) {
  const t = d instanceof Date ? d : new Date(d);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function weekKeyOf(now) {
  const t = new Date(now);
  const dow = (t.getDay() + 6) % 7;
  t.setHours(12, 0, 0, 0);
  return ymd(new Date(t.getTime() - dow * DAY));
}

function seasonKeyOf(now) {
  const t = new Date(now);
  return `${t.getFullYear()}Q${Math.floor(t.getMonth() / 3) + 1}`;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/* 上次合法值：从同目录的 .last.json 取（脚本每轮把干净版本落到这里） */
function lastValidOf(code) {
  return readJson(path.join(LEGIONS_DIR, '.' + code + '.last.json'));
}

function main() {
  const now = Date.now();
  const wk = weekKeyOf(now);
  const season = seasonKeyOf(now);
  const log = { day: ymd(now), at: now, fixed: [], rejected: [], paired: [], bye: [] };

  if (!fs.existsSync(LEGIONS_DIR)) {
    console.log('没有 legions/ 目录，跳过');
    writeJson(path.join(RESULTS_DIR, wk, 'pairing.json'), { week: wk, at: now, pairs: [], bye: [], anomalies: [], fixed: [] });
    return;
  }

  const files = fs.readdirSync(LEGIONS_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  const good = [];

  for (const name of files) {
    const code = name.replace(/\.json$/i, '');
    const file = readJson(path.join(LEGIONS_DIR, name));
    if (!file) {
      log.rejected.push({ code, why: '不是合法 JSON' });
      continue;
    }

    /* 1. 验签 */
    const opened = signer.openSealed(file);
    if (!opened.ok) {
      log.rejected.push({ code, why: opened.unsigned ? '没有签名（旧格式）' : opened.why });
      continue;
    }

    /* 2. 校验 + 修复 */
    const fixed = V.validateLegionFile(opened.payload, lastValidOf(opened.payload.code || code), now);
    if (fixed.fatal) {
      log.rejected.push({ code, why: fixed.fatal });
      continue;
    }
    if (!fixed.ok) {
      log.fixed.push({ code: fixed.value.code, warnings: fixed.warnings });
      /* 修复后的版本要重新签名 —— 用档案自带的公钥签不了（没私钥），
         所以只把「干净版本」落到 .last.json，供下一轮做回退基线；
         原文件保持不动，等军团主自己重写。 */
      writeJson(path.join(LEGIONS_DIR, '.' + fixed.value.code + '.last.json'), fixed.value);
    } else {
      writeJson(path.join(LEGIONS_DIR, '.' + fixed.value.code + '.last.json'), fixed.value);
    }

    const p = fixed.value;
    if (!p.season || !p.week) continue;
    if (p.season !== season || p.week !== wk) continue;
    if (now - (Number(p.updated) || 0) > FRESH_MS) continue;
    if (now < (Number(p.frozenUntil) || 0)) continue;

    good.push({
      code: p.code,
      rate7: Number(p.rate7) || 0,
      size: Number(p.size) || 0,
      anomalies: fixed.ok ? 0 : 1,
    });
  }

  /* 3. 相邻配对（按出操率升序） */
  good.sort((a, b) => a.rate7 - b.rate7 || String(a.code).localeCompare(String(b.code)));
  const pairs = [];
  const bye = [];
  for (let i = 0; i < good.length; i += 2) {
    if (i + 1 < good.length) pairs.push([good[i].code, good[i + 1].code]);
    else bye.push(good[i].code);
  }

  const anomalies = good.filter((g) => g.anomalies).map((g) => g.code);
  log.paired = pairs;
  log.bye = bye;

  writeJson(path.join(RESULTS_DIR, wk, 'pairing.json'), {
    week: wk,
    season,
    at: now,
    pairs,
    bye,
    anomalies,
    fixed: log.fixed.map((f) => f.code),
    counts: { total: files.length, valid: good.length, pairs: pairs.length, bye: bye.length },
  });

  /* 日志按天追加（保留最近 30 天） */
  const logPath = path.join(LOGS_DIR, log.day + '.json');
  const old = readJson(logPath) || { day: log.day, runs: [] };
  old.runs = Array.isArray(old.runs) ? old.runs : [];
  old.runs.push(log);
  if (old.runs.length > 50) old.runs = old.runs.slice(-50);
  writeJson(logPath, old);

  console.log(`✅ 校验 ${files.length} 份 · 有效 ${good.length} · 配对 ${pairs.length} 场 · 轮空 ${bye.length} · 修复 ${log.fixed.length} · 剔除 ${log.rejected.length}`);
  if (log.fixed.length) console.log('修复：', JSON.stringify(log.fixed, null, 2));
  if (log.rejected.length) console.log('剔除：', JSON.stringify(log.rejected, null, 2));
}

main();
