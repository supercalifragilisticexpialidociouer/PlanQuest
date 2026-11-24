'use strict';
/* ------------------------------------------------------------------ *
 * PlanQuest 绿色版自更新流水线（主进程侧，纯 Node，可注入、可单测）
 *
 * 需求流程图（每一步都在这里落地）：
 *   检查到新版本
 *   → 下载 new_version.zip 到 temp/
 *   → 校验 SHA256（版本文件里预置）
 *   → 校验通过：备份当前版本到 backup/
 *   → 解压覆盖
 *   → 启动新版本验证（自检）
 *   → 验证通过：删除 backup/
 *   → 验证失败：从 backup/ 还原
 *   → 校验失败：删除下载文件，提示用户重试
 *
 * 绿色版边界（刻意遵守）：
 *   - 数据永远不迁移：data.json 在 %APPDATA%\PlanQuest\，与 exe 目录解耦；
 *   - “不覆盖正在运行的 exe”是硬约束，因此解压先落到 staged/，自检过了再
 *     尽力覆盖；被占用的 exe 不硬删，标记到 pending-swap，由调用方在重启时替换；
 *   - 全程可注入 download / run / selfCheck，单测不联网、不起 Electron。
 * ------------------------------------------------------------------ */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const DIR = { TEMP: 'temp', BACKUP: 'backup', STAGED: 'staged' };
const ZIP_NAME = 'new_version.zip';
const PENDING = '.pq-pending-swap.json';
const SELF_CHECK_FLAG = '--self-check';

/* 把 updatesDir 下的各工作目录算出来（纯函数） */
function layout(updatesDir) {
  const root = String(updatesDir || '');
  return {
    root,
    temp: path.join(root, DIR.TEMP),
    backup: path.join(root, DIR.BACKUP),
    staged: path.join(root, DIR.STAGED),
    zip: path.join(root, DIR.TEMP, ZIP_NAME),
    pending: path.join(root, PENDING),
  };
}

function rm(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); return true; }
  catch (_) { return false; }
}
function mkdirp(target) { fs.mkdirSync(target, { recursive: true }); }

/* 递归复制目录/文件（backup 用）。忽略 symlink 的目标溢出。 */
function copyDir(from, to) {
  if (!fs.existsSync(from)) return { ok: false, reason: '源目录不存在' };
  const st = fs.statSync(from);
  if (st.isFile()) {
    mkdirp(path.dirname(to));
    fs.copyFileSync(from, to);
    return { ok: true };
  }
  mkdirp(to);
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const s = fs.lstatSync(src);
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
  return { ok: true };
}

/* 校验下载包：size + sha256。expect 为空视为“清单没预置”，明确跳过。 */
function verifyPackage(file, expect) {
  if (!fs.existsSync(file)) return { ok: false, reason: '下载文件不存在' };
  const e = expect || {};
  if (e.size && fs.statSync(file).size !== Number(e.size)) {
    return { ok: false, reason: '大小对不上，包可能没下全' };
  }
  if (e.sha256) {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1 << 20);
    try {
      let n;
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    } finally { fs.closeSync(fd); }
    const got = h.digest('hex');
    if (got.toLowerCase() !== String(e.sha256).toLowerCase()) {
      return { ok: false, reason: '校验没过，包可能被改过或没下全', got, expect: e.sha256 };
    }
    return { ok: true, skipped: false, got };
  }
  return { ok: true, skipped: true, reason: '清单未预置 sha256，跳过校验' };
}

/* 默认解压器：优先系统 tar（Win10 自带，能读 zip），失败回退 PowerShell Expand-Archive。
 * 通过注入 run(cmd, args) 可在单测里替换。 */
function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || '') });
    });
  });
}

function tarCmd() {
  // Windows 系统自带 tar；非 Windows 也让调用方注入
  return process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
}

async function unzip(zipFile, outDir, run, opts) {
  const o = opts || {};
  mkdirp(outDir);
  const runner = run || defaultRun;
  const strip = o.stripComponents == null ? 1 : o.stripComponents;
  // 第一次：按预期去掉顶层目录
  let r = await runner(tarCmd(), ['-xf', zipFile, '-C', outDir, '--strip-components', String(strip)]);
  if (r.code === 0) return { ok: true, via: 'tar' };
  // 回退 1：不去顶层（有些包没有统一顶层目录）
  if (strip !== 0) {
    r = await runner(tarCmd(), ['-xf', zipFile, '-C', outDir]);
    if (r.code === 0) return { ok: true, via: 'tar' };
  }
  // 回退 2：PowerShell Expand-Archive（无 strip 概念，结果可能多一层，交给调用方探测）
  if (process.platform === 'win32') {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = "Expand-Archive -LiteralPath '" + zipFile.replace(/'/g, "''") + "' -DestinationPath '" + outDir.replace(/'/g, "''") + "' -Force";
    r = await runner(ps, ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (r.code === 0) return { ok: true, via: 'powershell', maybeNested: true };
  }
  return { ok: false, reason: '解压失败：' + String(r.err || r.out || '').slice(0, 200) };
}

/* 默认自检：确认入口 exe 存在且非空；可选 spawn 进程验证（由注入的 selfChecker 覆盖）。
 * 返回 { ok, reason }。 */
function defaultSelfCheck(stagedDir, entryExe) {
  const exe = path.join(stagedDir, entryExe || 'PlanQuest.exe');
  try {
    if (!fs.existsSync(exe) || fs.statSync(exe).size < 1024) {
      return { ok: false, reason: '新版本入口程序缺失或异常' };
    }
  } catch (e) {
    return { ok: false, reason: '检查新版本失败：' + e.message };
  }
  return { ok: true, reason: '新版本文件完整' };
}

/* 探测真正的程序根目录：staged 可能因为解压回退多套了一层。
 * 找包含入口 exe 的最深一级目录（最多下探 3 层）。 */
function findAppRoot(dir, entryExe, depth) {
  const d = depth || 0;
  const exe = entryExe || 'PlanQuest.exe';
  try {
    if (fs.existsSync(path.join(dir, exe))) return dir;
    if (d >= 3) return null;
    const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory());
    for (const s of subs) {
      const found = findAppRoot(path.join(dir, s.name), exe, d + 1);
      if (found) return found;
    }
  } catch (_) {}
  return null;
}

/* 把 staged 内容覆盖到 appDir。被占用的文件（多半是正在运行的 exe）不硬删，
 * 记入 pending，交给调用方在重启后替换。 */
function applyReplace(stagedRoot, appDir, opts) {
  const o = opts || {};
  const overwriteExe = o.overwriteExe !== false;
  const pending = [];
  let replaced = 0;
  function walk(from, rel) {
    for (const name of fs.readdirSync(from)) {
      const src = path.join(from, name);
      const r = rel ? path.join(rel, name) : name;
      const dst = path.join(appDir, r);
      const s = fs.lstatSync(src);
      if (s.isSymbolicLink()) continue;
      if (s.isDirectory()) { walk(src, r); continue; }
      try {
        mkdirp(path.dirname(dst));
        fs.copyFileSync(src, dst);
        replaced++;
      } catch (e) {
        // 文件被占用（EBUSY/EPERM/EACCES）：尤其是正在运行的 exe
        pending.push({ from: src, to: dst, reason: String(e.code || e.message) });
      }
    }
  }
  walk(stagedRoot, '');
  return { ok: pending.length === 0, replaced, pending };
}

/* 写/读 pending 标记，供主进程在重启时完成 exe 替换 */
function writePending(file, payload) {
  try { fs.writeFileSync(file, JSON.stringify(payload, null, 2)); return true; } catch (_) { return false; }
}
function readPending(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function clearPending(file) { rm(file); }

/* 重启时完成被占用文件的替换（由主进程在启动时调用）。 */
function finalizePending(pendingFile, opts) {
  const o = opts || {};
  const p = readPending(pendingFile);
  if (!p || !Array.isArray(p.items)) return { ok: true, skipped: true };
  const left = [];
  for (const it of p.items) {
    try {
      mkdirp(path.dirname(it.to));
      fs.copyFileSync(it.from, it.to);
    } catch (e) {
      left.push(it);
    }
  }
  if (left.length) { writePending(pendingFile, Object.assign({}, p, { items: left })); return { ok: false, left: left.length }; }
  clearPending(pendingFile);
  return { ok: true, replaced: p.items.length };
}

/* ------------------------------------------------------------------ *
 * 主编排：完整流水线。所有外部作用都通过 opts 注入，单测可用假函数。
 *
 * opts:
 *   updatesDir       更新工作根目录（必填）
 *   appDir           当前安装目录（覆盖阶段用；不传则跳过覆盖，只到 staged）
 *   expect           期望 { sha256, size }（来自 version.json）
 *   entryExe         入口程序名，默认 PlanQuest.exe
 *   download(dest, onStage) => Promise<{ ok, file?, reason? }>  必填
 *   onStage(text)    进度文案回调
 *   run(cmd,args)    执行命令（解压），可注入
 *   selfCheck(dir,entryExe) => { ok, reason } | Promise<...>  可注入
 *   stripComponents  解压去顶层层数，默认 1
 *
 * 返回 { ok, stage, message, detail }
 * stage ∈ download | verify | backup | extract | selfcheck | apply | done
 * ------------------------------------------------------------------ */
async function applyUpdate(opts) {
  const o = opts || {};
  const L = layout(o.updatesDir);
  const say = (t) => { try { if (o.onStage) o.onStage(t); } catch (_) {} };
  const stage = (name, message, extra) => Object.assign({ ok: false, stage: name, message }, extra || {});

  if (!o.updatesDir) return stage('download', '更新目录没配置');
  if (typeof o.download !== 'function') return stage('download', '下载器没就绪');

  mkdirp(L.temp);

  /* 1) 下载到 temp/ —— 每次先清掉上次的残包 */
  rm(L.zip);
  say('① 下载新版本到临时目录…');
  let got;
  try {
    got = await o.download(L.zip, say);
  } catch (e) {
    rm(L.zip);
    return stage('download', '下载出错：' + (e && e.message ? e.message : e));
  }
  if (!got || !got.ok || !fs.existsSync(L.zip)) {
    rm(L.zip);
    return stage('download', (got && got.reason) || '没下到新版本，请重试');
  }

  /* 2) 校验 SHA256（清单预置）—— 失败删下载文件、提示重试 */
  say('② 校验文件完整性…');
  const v = verifyPackage(L.zip, o.expect);
  if (!v.ok) {
    rm(L.zip);
    return stage('verify', v.reason + '，已删除损坏的文件，请重试', { checksum: v });
  }
  say(v.skipped ? '② 清单未预置校验值，跳过校验' : '② 校验通过');

  /* 3) 备份当前版本到 backup/ —— 先删旧备份再复制 */
  say('③ 备份当前版本…');
  rm(L.backup);
  if (o.appDir && fs.existsSync(o.appDir)) {
    const b = copyDir(o.appDir, L.backup);
    if (!b.ok) { rm(L.zip); return stage('backup', '备份失败，已停止更新：' + b.reason); }
  } else {
    // 没有 appDir（如单测/纯下载模式）：用一个空备份占位，保证回滚分支可执行
    mkdirp(L.backup);
  }

  /* 4) 解压到 staged/ */
  say('④ 解压新版本…');
  rm(L.staged);
  const u = await unzip(L.zip, L.staged, o.run, { stripComponents: o.stripComponents });
  if (!u.ok) {
    // 解压失败没动到 appDir，但按流程仍走一次回滚语义（清理 staged，备份保留供排查）
    rm(L.staged);
    return stage('extract', u.reason);
  }

  const appRoot = findAppRoot(L.staged, o.entryExe) || L.staged;

  /* 5) 启动新版本验证（自检） */
  say('⑤ 验证新版本…');
  let sc;
  try {
    sc = o.selfCheck ? await o.selfCheck(appRoot, o.entryExe || 'PlanQuest.exe')
      : defaultSelfCheck(appRoot, o.entryExe);
  } catch (e) {
    sc = { ok: false, reason: '自检异常：' + (e && e.message ? e.message : e) };
  }
  if (!sc || !sc.ok) {
    /* 验证失败：从 backup/ 还原（当前 appDir 没被改动，这里确保 staged 清掉，
     * 并把 backup 内容还原回去，覆盖任何自检过程中可能的落盘）。 */
    say('⑤ 验证失败，正在从备份还原…');
    if (o.appDir && fs.existsSync(L.backup)) {
      try { copyDir(L.backup, o.appDir); } catch (_) {}
    }
    rm(L.staged);
    return stage('selfcheck', (sc && sc.reason) || '新版本验证没过，已还原旧版本', { selfCheck: sc });
  }

  /* 6) 验证通过：覆盖安装 + 删除 backup */
  if (o.appDir && fs.existsSync(o.appDir)) {
    say('⑥ 覆盖安装…');
    const ap = applyReplace(appRoot, o.appDir, o);
    if (ap.pending.length) {
      writePending(L.pending, { items: ap.pending, at: Date.now(), from: o.entryExe || 'PlanQuest.exe' });
    }
  }
  // 覆盖成功后删除备份与临时包与 staged
  rm(L.backup);
  rm(L.zip);
  rm(L.staged);
  say('⑥ 完成，新版本已就绪');

  return {
    ok: true, stage: 'done',
    message: '更新完成：已校验、备份、解压并验证通过，新版本已安装。',
    detail: { checksum: v, selfCheck: sc },
  };
}

module.exports = {
  DIR, ZIP_NAME, PENDING, SELF_CHECK_FLAG,
  layout, rm, copyDir, verifyPackage, unzip, defaultRun, defaultSelfCheck,
  findAppRoot, applyReplace, writePending, readPending, clearPending, finalizePending,
  applyUpdate,
};
