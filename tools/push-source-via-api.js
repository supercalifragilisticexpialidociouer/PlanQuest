#!/usr/bin/env node
/* PlanQuest · 通过 GitHub REST API 推送「精简源码」到仓库
 *
 * github.com 的 git 协议超时，但 api.github.com 通。走 Git Data API：
 *   blob → tree → commit → 更新 ref，全程 REST。
 *
 * 只传必要文件（白名单目录），跳过 dist/android-app 的重复副本、编译产物、
 * 大二进制资产（那些走 Releases）。约 300 个文件，避免 1500 个传一半断掉。
 *
 * 用法：GITHUB_TOKEN=ghp_xxx node tools/push-source-via-api.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('需要 GITHUB_TOKEN'); process.exit(1); }

const OWNER = 'supercalifragilisticexpialidociouer';
const REPO = 'PlanQuest';
const BRANCH = 'main';
const ROOT = path.resolve(__dirname, '..');
const API = 'api.github.com';

// 只传这些根目录（源码 + 文档 + 构建脚本 + dist 的清单 json）
const INCLUDE_DIRS = ['web', 'src', 'tools', 'scripts', 'dev-tests'];
const INCLUDE_ROOT_FILES = ['package.json', 'package-lock.json', '使用说明.txt'];
const INCLUDE_DIST_FILES = ['version.json', '版本清单.json', '更新日志.html', '完整手册.html'];
// 明确排除：大资产/二进制（走 Releases 或可再生）
const SKIP_EXT = new Set(['.zip', '.exe', '.mp4', '.pak', '.jar', '.dex', '.onnx', '.wasm', '.bin', '.woff', '.woff2', '.ttf']);
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'vendor', 'build', 'intermediates', 'generated', 'locales']);
const MAX_BLOB = 30 * 1024 * 1024;

function api(method, endpoint, body, retries = 4) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const doReq = () => {
      const req = https.request({
        hostname: API, path: '/repos/' + OWNER + '/' + REPO + endpoint,
        method, timeout: 30000,
        headers: Object.assign({
          'Authorization': 'Bearer ' + TOKEN,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'PlanQuest-Upload', 'X-GitHub-Api-Version': '2022-11-28',
        }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
          } else if ((res.statusCode === 429 || res.statusCode >= 500) && retries > 0) {
            setTimeout(doReq, 3000);
          } else reject(new Error(method + ' ' + endpoint + ' -> ' + res.statusCode + ': ' + buf.slice(0, 150)));
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => retries > 0 ? setTimeout(doReq, 2000) : reject(new Error(e.message)));
      if (data) req.write(data);
      req.end();
    };
    doReq();
  });
}

function collect() {
  const files = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) {
        if (SKIP_EXT.has(path.extname(name).toLowerCase())) continue;
        if (stat.size > MAX_BLOB) continue;
        files.push(rel);
      }
    }
  }
  for (const d of INCLUDE_DIRS) {
    const p = path.join(ROOT, d);
    if (fs.existsSync(p)) walk(p);
  }
  for (const f of INCLUDE_ROOT_FILES) if (fs.existsSync(path.join(ROOT, f))) files.push(f);
  for (const f of INCLUDE_DIST_FILES) {
    const p = path.join(ROOT, 'dist', f);
    if (fs.existsSync(p)) files.push('dist/' + f);
  }
  return [...new Set(files)];
}

(async () => {
  const files = collect();
  console.log('==> 待上传 ' + files.length + ' 个精简文件');

  let parentSha = null, baseTree = null;
  try {
    const refs = await api('GET', '/git/ref/heads/' + BRANCH);
    parentSha = refs.object.sha;
    baseTree = (await api('GET', '/git/commits/' + parentSha)).tree.sha;
    console.log('    父提交 ' + parentSha.slice(0, 8));
  } catch { console.log('    仓库为空，作为初始提交'); }

  const tree = [];
  let ok = 0, fail = 0;
  for (let i = 0; i < files.length; i++) {
    const rel = files[i];
    const full = path.join(ROOT, rel);
    const content = fs.readFileSync(full);
    const mode = (fs.statSync(full).mode & 0o111) ? '100755' : '100644';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const blob = await api('POST', '/git/blobs', { content: content.toString('base64'), encoding: 'base64' });
        tree.push({ path: rel, mode, type: 'blob', sha: blob.sha });
        ok++;
        break;
      } catch (e) {
        if (attempt === 1) { fail++; console.log('    [跳过] ' + rel + ': ' + e.message.slice(0, 80)); }
      }
    }
    if ((i + 1) % 40 === 0) console.log('    ' + (i + 1) + '/' + files.length + ' (ok ' + ok + ', fail ' + fail + ')');
  }

  console.log('==> tree: ' + tree.length + ' 项');
  const createdTree = await api('POST', '/git/trees', Object.assign({ tree }, baseTree ? { base_tree: baseTree } : {}));
  console.log('==> commit');
  const commitBody = { message: 'PlanQuest v2.9.11: 源码与文档', tree: createdTree.sha };
  if (parentSha) commitBody.parents = [parentSha];
  const commit = await api('POST', '/git/commits', commitBody);
  console.log('    ' + commit.sha.slice(0, 8));
  console.log('==> 更新 ' + BRANCH);
  await api('PATCH', '/git/refs/heads/' + BRANCH, { sha: commit.sha, force: true });
  console.log('==> 完成: https://github.com/' + OWNER + '/' + REPO + '  (成功 ' + ok + ' / 跳过 ' + fail + ')');
})().catch((e) => { console.error('!! 失败: ' + e.message); process.exit(1); });
