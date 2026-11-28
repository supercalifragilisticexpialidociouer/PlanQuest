#!/usr/bin/env node
/* 用 GitHub REST API 覆盖 Release 附件（同名先删后传）。
 * git CONNECT 被代理拦时走 api.github.com + uploads.github.com。
 * 用法：GITHUB_TOKEN=... node tools/replace-release-assets.js [仅传指定资产名]
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

/* 本地文件 -> Release 资产名（助手用 ASCII 名，避免客户端 URL 中文转义问题） */
const ASSETS = [
  { local: 'dist/PlanQuest-win64-portable.zip', name: 'PlanQuest-win64-portable.zip' },
  { local: 'dist/releases/PlanQuest-安装助手.exe', name: 'PlanQuest-install-assistant.exe' },
  { local: 'dist/releases/PlanQuest-2.9.11-setup.exe', name: 'PlanQuest-2.9.11-setup.exe' },
  { local: 'dist/version.json', name: 'version.json' },
];
const ONLY = new Set(process.argv.slice(2));

function request(hostname, reqPath, method, body, headers, retries = 3) {
  return new Promise((resolve, reject) => {
    const doReq = () => {
      const req = https.request({
        hostname, path: reqPath, method, timeout: 180000,
        headers: Object.assign({
          'Authorization': 'Bearer ' + TOKEN,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'PlanQuest-Sync',
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
      req.on('error', (e) => retries > 0 ? setTimeout(doReq, 2000) : reject(e));
      if (body) req.write(body);
      req.end();
    };
    doReq();
  });
}

(async () => {
  const release = await request('api.github.com',
    `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, 'GET');
  console.log('Release id=' + release.id + ' tag=' + release.tag_name);

  for (const asset of ASSETS) {
    if (ONLY.size && !ONLY.has(asset.name)) continue;
    const full = path.join(ROOT, asset.local);
    if (!fs.existsSync(full)) { console.log('  跳过（本地不存在）' + asset.local); continue; }
    const old = (release.assets || []).find((a) => a.name === asset.name);
    if (old) {
      console.log('  删除旧附件 ' + asset.name + ' (id=' + old.id + ')');
      await request('api.github.com',
        `/repos/${OWNER}/${REPO}/releases/assets/${old.id}`, 'DELETE');
    }
    const body = fs.readFileSync(full);
    console.log('  上传 ' + asset.name + ' (' + (body.length / 1048576).toFixed(1) + ' MB) ...');
    const uploaded = await request('uploads.github.com',
      `/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`,
      'POST', body,
      { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
    console.log('    OK ' + uploaded.browser_download_url);
  }
  console.log('DONE https://github.com/' + OWNER + '/' + REPO + '/releases/tag/' + TAG);
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
