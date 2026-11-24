'use strict';
/* 绿色版自更新流水线：纯逻辑单测，不联网、不起 Electron、不真解压 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const F = require('../src/update-flow.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (!cond) { fail++; console.error('FAIL  ' + name); }
  else { pass++; console.log('ok    ' + name); }
}
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-flow-'));
function sub(name) { const p = path.join(tmpRoot, name); fs.mkdirSync(p, { recursive: true }); return p; }
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

(async () => {
  /* 1) layout 路径计算 */
  const L = F.layout(path.join(tmpRoot, 'updates'));
  ok('temp 目录', L.temp.endsWith(path.join('updates', 'temp')));
  ok('backup 目录', L.backup.endsWith(path.join('updates', 'backup')));
  ok('staged 目录', L.staged.endsWith(path.join('updates', 'staged')));
  ok('zip 在 temp 下', L.zip === path.join(L.temp, 'new_version.zip'));

  /* 2) verifyPackage：size + sha256 */
  const f = path.join(tmpRoot, 'p.bin');
  const content = Buffer.from('planquest-update-payload');
  fs.writeFileSync(f, content);
  const h = sha(content);
  ok('正确 sha256 通过', F.verifyPackage(f, { sha256: h }).ok === true);
  ok('正确 size 通过', F.verifyPackage(f, { size: content.length }).ok === true);
  ok('错误 sha256 被拒', F.verifyPackage(f, { sha256: 'deadbeef' }).ok === false);
  ok('错误 size 被拒', F.verifyPackage(f, { size: 999 }).ok === false);
  ok('没给期望值 → 跳过', F.verifyPackage(f, {}).skipped === true);
  ok('文件不存在 → 失败', F.verifyPackage(path.join(tmpRoot, 'nope'), {}).ok === false);

  /* 3) copyDir 备份 + 目录遍历 */
  const srcDir = sub('srcapp');
  fs.writeFileSync(path.join(srcDir, 'PlanQuest.exe'), Buffer.alloc(2048, 1));
  fs.mkdirSync(path.join(srcDir, 'resources'));
  fs.writeFileSync(path.join(srcDir, 'resources', 'app.asar'), Buffer.from('asar'));
  const bkDir = path.join(tmpRoot, 'bk');
  F.copyDir(srcDir, bkDir);
  ok('备份复制了 exe', fs.existsSync(path.join(bkDir, 'PlanQuest.exe')));
  ok('备份复制了子目录文件', fs.existsSync(path.join(bkDir, 'resources', 'app.asar')));
  ok('不存在的源备份失败', F.copyDir(path.join(tmpRoot, 'missing'), path.join(tmpRoot, 'x')).ok === false);

  /* 4) findAppRoot：解压多套一层也能找到入口 */
  const staged = sub('staged');
  fs.mkdirSync(path.join(staged, 'PlanQuest-win64', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(staged, 'PlanQuest-win64', 'PlanQuest.exe'), Buffer.alloc(2048, 1));
  const found = F.findAppRoot(staged, 'PlanQuest.exe');
  ok('找到嵌套的 app 根', !!found && found.endsWith('PlanQuest-win64'));
  ok('入口缺失返回 null', F.findAppRoot(sub('empty'), 'PlanQuest.exe') === null);

  /* 5) applyReplace：覆盖 + 占用文件记 pending */
  const appDir = sub('app');
  fs.writeFileSync(path.join(appDir, 'PlanQuest.exe'), Buffer.from('OLD'));
  fs.writeFileSync(path.join(appDir, 'keep.txt'), Buffer.from('KEEP'));
  const stagedRoot = path.join(staged, 'PlanQuest-win64');
  fs.writeFileSync(path.join(stagedRoot, 'new-file.txt'), Buffer.from('NEW'));
  const ap = F.applyReplace(stagedRoot, appDir);
  ok('覆盖执行了', ap.replaced >= 2 && ap.ok === true);
  ok('新 exe 内容已覆盖', fs.readFileSync(path.join(appDir, 'PlanQuest.exe'), 'utf8') !== 'OLD');

  /* 6) pending 写读清 + finalize */
  const pendingFile = path.join(tmpRoot, 'pending.json');
  F.writePending(pendingFile, { items: [{ from: path.join(stagedRoot, 'PlanQuest.exe'), to: path.join(appDir, 'keep.txt') }] });
  ok('pending 可读', !!F.readPending(pendingFile) && F.readPending(pendingFile).items.length === 1);
  const fin = F.finalizePending(pendingFile);
  ok('finalize 后完成', fin.ok === true && fin.replaced === 1);
  ok('finalize 后 pending 被清', F.readPending(pendingFile) === null);

  /* 7) —— 完整流水线 applyUpdate（注入假 download / run / selfCheck）—— */
  const mkDownloader = (okDownload, expect) => async (dest, say) => {
    if (!okDownload) return { ok: false, reason: '模拟下载失败' };
    // 造一个"zip"，内容其实是可复制的假 payload；解压器用假 run 直接铺 staged
    fs.writeFileSync(dest, expect || Buffer.from('zip-bytes'));
    return { ok: true, file: dest };
  };
  // 假解压：忽略 zip 内容，直接往 outDir（第 3 个参数是 -C 的目标）铺一个带 exe 的目录
  const fakeRun = (cmd, args) => {
    const outDir = args[args.indexOf('-C') + 1];
    const root = path.join(outDir, 'PlanQuest-win64');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'PlanQuest.exe'), Buffer.alloc(2048, 7));
    fs.writeFileSync(path.join(root, 'new-file.txt'), Buffer.from('NEW'));
    return Promise.resolve({ code: 0, out: '', err: '' });
  };

  // 7a) 校验失败 → 删下载文件、stage=verify
  {
    const upd = sub('upd-verify-fail');
    const r = await F.applyUpdate({
      updatesDir: upd,
      expect: { sha256: 'WRONGHASH' },
      download: mkDownloader(true),
      run: fakeRun,
      selfCheck: () => ({ ok: true }),
    });
    ok('校验失败 → stage=verify', r.stage === 'verify' && r.ok === false);
    ok('校验失败 → 下载文件被删', !fs.existsSync(path.join(upd, 'temp', 'new_version.zip')));
    ok('校验失败 → 提示重试', r.message.includes('重试'));
  }

  // 7b) 下载失败 → stage=download
  {
    const upd = sub('upd-download-fail');
    const r = await F.applyUpdate({ updatesDir: upd, download: mkDownloader(false) });
    ok('下载失败 → stage=download', r.stage === 'download' && r.ok === false);
  }

  // 7c) 自检失败 → stage=selfcheck + 从 backup 还原
  {
    const upd = sub('upd-selfcheck-fail');
    const app = sub('app-scfail');
    fs.writeFileSync(path.join(app, 'PlanQuest.exe'), Buffer.from('ORIGINAL'));
    const r = await F.applyUpdate({
      updatesDir: upd, appDir: app,
      download: mkDownloader(true),
      run: fakeRun,
      selfCheck: () => ({ ok: false, reason: '模拟自检不通过' }),
    });
    ok('自检失败 → stage=selfcheck', r.stage === 'selfcheck' && r.ok === false);
    ok('自检失败 → 旧版本被还原', fs.readFileSync(path.join(app, 'PlanQuest.exe'), 'utf8') === 'ORIGINAL');
  }

  // 7d) 全流程成功 → stage=done，backup/staged/zip 清空，新文件落地
  {
    const upd = sub('upd-ok');
    const app = sub('app-ok');
    fs.writeFileSync(path.join(app, 'PlanQuest.exe'), Buffer.from('OLD'));
    const stages = [];
    const payload = Buffer.from('zip-ok');
    const r = await F.applyUpdate({
      updatesDir: upd, appDir: app,
      expect: { sha256: sha(payload) },
      download: mkDownloader(true, payload),
      run: fakeRun,
      selfCheck: () => ({ ok: true }),
      onStage: (t) => stages.push(t),
    });
    ok('全流程成功 → ok', r.ok === true && r.stage === 'done');
    ok('校验通过标记', r.detail.checksum.ok === true && r.detail.checksum.skipped === false);
    ok('自检通过', r.detail.selfCheck.ok === true);
    ok('backup 被删除', !fs.existsSync(path.join(upd, 'backup')));
    ok('staged 被删除', !fs.existsSync(path.join(upd, 'staged')));
    ok('zip 被删除', !fs.existsSync(path.join(upd, 'temp', 'new_version.zip')));
    ok('新文件已覆盖到 appDir', fs.existsSync(path.join(app, 'new-file.txt')));
    ok('收到阶段进度', stages.length >= 5 && stages.some((s) => s.includes('校验')));
  }

  // 7e) 自检前备份存在（流程中段检查）——注入一个在 selfCheck 里偷看 backup 的探针
  {
    const upd = sub('upd-backup-probe');
    let backupExistedAtCheck = false;
    await F.applyUpdate({
      updatesDir: upd,
      download: mkDownloader(true),
      run: fakeRun,
      selfCheck: () => { backupExistedAtCheck = fs.existsSync(path.join(upd, 'backup')); return { ok: true }; },
    });
    ok('自检时 backup 仍在（成功后才删）', backupExistedAtCheck === true);
  }

  console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
  if (fail) process.exitCode = 1;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
})();
