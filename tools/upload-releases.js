#!/usr/bin/env node
/* PlanQuest · 通过 GitHub REST API 创建 Release 并上传大文件
 *
 * github.com 的 git 协议超时，但 api.github.com 和 uploads.github.com 可用。
 * Release 元数据走 api.github.com，附件走 uploads.github.com（GitHub 官方分离设计）。
 *
 * 用法：GITHUB_TOKEN=ghp_xxx node tools/upload-releases.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('需要 GITHUB_TOKEN'); process.exit(1); }

const OWNER = 'supercalifragilisticexpialidociouer';
const REPO = 'PlanQuest';
const TAG = 'v2.9.11';
const ROOT = path.resolve(__dirname, '..');

const FILES = [
  'dist/PlanQuest-win64-portable.zip',
  'dist/releases/PlanQuest-2.9.11-setup.exe',
  'dist/releases/PlanQuest-2.9.10-setup.exe',
  'dist/releases/PlanQuest-2.9.9-setup.exe',
  'dist/releases/PlanQuest-安装助手.exe',
];

function request(hostname, reqPath, method, body, headers, retries = 3) {
  return new Promise((resolve, reject) => {
    const doReq = () => {
      const req = https.request({
        hostname, path: reqPath, method, timeout: 120000,
        headers: Object.assign({
          'Authorization': 'Bearer ' + TOKEN,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'PlanQuest-Upload',
          'X-GitHub-Api-Version': '2022-11-28',
        }, headers || {}),
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
          } else if ((res.statusCode === 429 || res.statusCode >= 500) && retries > 0) {
            setTimeout(doReq, 3000);
          } else reject(new Error(res.statusCode + ': ' + buf.slice(0, 200)));
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => {
        if (retries > 0) setTimeout(doReq, 2000);
        else reject(e);
      });
      if (body) req.write(body);
      req.end();
    };
    doReq();
  });
}

(async () => {
  console.log('==> 查询已有 Release');
  let release;
  try {
    release = await request('api.github.com', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, 'GET');
    console.log('    复用已有 Release id=' + release.id);
  } catch {
    console.log('    创建新 Release');
    const payload = Buffer.from(JSON.stringify({
      tag_name: TAG, name: 'PlanQuest ' + TAG,
      body: '绿色版 + 安装助手。新手期翻案隔离，五源冗余更新。\n\n- 绿色 ZIP：下载后解压即用\n- 安装助手：2MB 引导器，选版本/选是否装 AI\n- setup.exe：离线整包，不联网也能装',
      draft: false, prerelease: false,
    }));
    release = await request('api.github.com', `/repos/${OWNER}/${REPO}/releases`, 'POST', payload,
      { 'Content-Type': 'application/json', 'Content-Length': payload.length });
    console.log('    创建成功 id=' + release.id);
  }

  console.log('==> 检查已有附件');
  const existing = new Set((release.assets || []).map((a) => a.name));

  for (const rel of FILES) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) { console.log('    跳过（不存在）' + rel); continue; }
    const name = path.basename(full);
    if (existing.has(name)) { console.log('    跳过（已存在）' + name); continue; }
    const size = fs.statSync(full).size;
    console.log('    上传 ' + name + ' (' + (size / 1048576).toFixed(0) + ' MB) ...');
    const body = fs.readFileSync(full);
    const asset = await request('uploads.github.com',
      `/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      'POST', body,
      { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
    console.log('      OK -> ' + (asset.browser_download_url || ' uploaded'));
  }

  console.log('==> 完成: https://github.com/' + OWNER + '/' + REPO + '/releases/tag/' + TAG);
})().catch((e) => { console.error('!! 失败: ' + e.message); process.exit(1); });
