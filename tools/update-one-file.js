#!/usr/bin/env node
/* 更新 GitHub 仓库里的单个文件（Git Data API），避免全量重传。
 * 用法：GITHUB_TOKEN=... node tools/update-one-file.js <本地相对路径> <仓库路径> [提交信息] */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const TOKEN = process.env.GITHUB_TOKEN;
const LOCAL = process.argv[2];
const REPOPATH = process.argv[3] || LOCAL;
const MSG = process.argv[4] || 'chore: update ' + REPOPATH;
if (!TOKEN || !LOCAL) { console.error('需要 GITHUB_TOKEN 和本地路径'); process.exit(1); }

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
      req.on('error', (e) => retries > 0 ? setTimeout(doReq, 2000) : reject(e));
      if (data) req.write(data);
      req.end();
    };
    doReq();
  });
}

(async () => {
  const content = fs.readFileSync(path.join(ROOT, LOCAL));
  console.log('==> 上传 blob: ' + LOCAL + ' (' + content.length + ' bytes)');
  const blob = await api('POST', '/git/blobs', { content: content.toString('base64'), encoding: 'base64' });
  const refs = await api('GET', '/git/ref/heads/' + BRANCH);
  const parentSha = refs.object.sha;
  const commit = await api('GET', '/git/commits/' + parentSha);
  const baseTree = commit.tree.sha;
  console.log('==> 父提交 ' + parentSha.slice(0, 8));
  const tree = await api('POST', '/git/trees', {
    base_tree: baseTree,
    tree: [{ path: REPOPATH, mode: '100644', type: 'blob', sha: blob.sha }],
  });
  const newCommit = await api('POST', '/git/commits', { message: MSG, tree: tree.sha, parents: [parentSha] });
  await api('PATCH', '/git/refs/heads/' + BRANCH, { sha: newCommit.sha, force: true });
  console.log('==> 完成 commit ' + newCommit.sha.slice(0, 8));
})().catch((e) => { console.error('!! 失败: ' + e.message); process.exit(1); });
