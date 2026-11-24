#!/usr/bin/env node
/* 把本次改动的文件一次性推到 GitHub 仓库（Git Data API，单 commit）。
 * 用法：GITHUB_TOKEN=... node tools/push-changed-files.js <相对路径> [相对路径...] */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const TOKEN = process.env.GITHUB_TOKEN;
const FILES = process.argv.slice(2);
if (!TOKEN || !FILES.length) { console.error('需要 GITHUB_TOKEN 和文件列表'); process.exit(1); }

const OWNER = 'supercalifragilisticexpialidociouer';
const REPO = 'PlanQuest';
const BRANCH = 'main';
const ROOT = path.resolve(__dirname, '..');

function api(method, endpoint, body, retries = 4) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const doReq = () => {
      const req = https.request({
        hostname: 'api.github.com', path: '/repos/' + OWNER + '/' + REPO + endpoint,
        method, timeout: 30000,
        headers: Object.assign({
          'Authorization': 'Bearer ' + TOKEN, 'Accept': 'application/vnd.github+json',
          'User-Agent': 'PlanQuest-Upload', 'X-GitHub-Api-Version': '2022-11-28',
        }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
          } else if ((res.statusCode === 429 || res.statusCode >= 500) && retries > 0) setTimeout(doReq, 3000);
          else reject(new Error(method + ' ' + endpoint + ' -> ' + res.statusCode + ': ' + buf.slice(0, 150)));
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => retries > 0 ? setTimeout(doReq, 2000) : reject(e));
      if (data) req.write(data);
      req.end();
    };
    doReq();
  });
}

(async () => {
  const refs = await api('GET', '/git/ref/heads/' + BRANCH);
  const parentSha = refs.object.sha;
  const commit = await api('GET', '/git/commits/' + parentSha);
  const baseTree = commit.tree.sha;
  console.log('父提交 ' + parentSha.slice(0, 8));

  const tree = [];
  for (const rel of FILES) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) { console.log('  跳过（不存在）' + rel); continue; }
    const content = fs.readFileSync(full);
    const mode = (fs.statSync(full).mode & 0o111) ? '100755' : '100644';
    const blob = await api('POST', '/git/blobs', { content: content.toString('base64'), encoding: 'base64' });
    tree.push({ path: rel.replace(/\\/g, '/'), mode, type: 'blob', sha: blob.sha });
    console.log('  blob ' + rel + ' (' + content.length + 'B)');
  }
  const created = await api('POST', '/git/trees', { base_tree: baseTree, tree });
  const newCommit = await api('POST', '/git/commits', {
    message: process.env.MSG || 'PlanQuest 源码更新',
    tree: created.sha, parents: [parentSha],
  });
  await api('PATCH', '/git/refs/heads/' + BRANCH, { sha: newCommit.sha, force: true });
  console.log('完成 commit ' + newCommit.sha.slice(0, 8) + '（' + tree.length + ' 文件）');
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
