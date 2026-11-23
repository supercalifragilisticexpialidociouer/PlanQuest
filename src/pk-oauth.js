/* PlanQuest · GitHub 官方 OAuth（Device Flow）
 *
 * 为什么用 Device Flow：这是 GitHub 给「没有服务器、也没法开浏览器回调」的
 * 桌面应用准备的官方流程。全程不需要 client_secret（公开客户端），
 * 也不需要用户去后台点「生成 token」再复制粘贴。
 *
 * 流程：
 *   1. POST /login/device/code             → 拿到 user_code 与 device_code
 *   2. 让用户打开 https://github.com/login/device 输入 user_code（手机上也能做）
 *   3. 本机按 interval 轮询 /login/oauth/access_token
 *      → authorization_pending（继续等）/ slow_down（降低频率）/ access_token（成功）
 *
 * 需要的东西只有一个 client_id：在 GitHub → Settings → Developer settings →
 * OAuth Apps 建一个应用，回调地址留空即可，把 Client ID 填到设置里（一次性）。
 * 这里不内置任何 client_id —— 内置等于把你我共用一个应用身份，审计上说不清。
 */
'use strict';

const https = require('node:https');

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const VERIFY_URL = 'https://github.com/login/device';
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function postJson(url, body, { timeout = 15000 } = {}) {
  const data = JSON.stringify(body);
  return new Promise((resolve) => {
    let req;
    try {
      req = https.request(
        url,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'User-Agent': 'PlanQuest',
          },
          timeout,
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(raw);
            } catch (_) {
              json = null;
            }
            resolve({ status: res.statusCode || 0, json, raw });
          });
        }
      );
    } catch (e) {
      resolve({ status: 0, json: null, raw: String(e && e.message) });
      return;
    }
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (e) => resolve({ status: 0, json: null, raw: String(e && e.message) }));
    req.write(data);
    req.end();
  });
}

/* 把 GitHub 的响应翻译成 UI 能直接用的状态，纯函数，方便单测 */
function readTokenResponse(r) {
  const j = (r && r.json) || {};
  if (j.access_token) {
    return { status: 'ok', token: String(j.access_token), scope: String(j.scope || ''), message: '' };
  }
  const err = String(j.error || '');
  if (err === 'authorization_pending') return { status: 'pending', message: '等待你在浏览器里确认…' };
  if (err === 'slow_down') return { status: 'slow', message: 'GitHub 要求放慢轮询，已自动降频' };
  if (err === 'expired_token') return { status: 'expired', message: '这个验证码过期了，重新点一次登录' };
  if (err === 'access_denied') return { status: 'denied', message: '你在 GitHub 上取消了授权' };
  if (err === 'incorrect_client_credentials') return { status: 'bad_client', message: 'client_id 不对，检查一下 OAuth App 的 Client ID' };
  if (err === 'device_flow_disabled') return { status: 'disabled', message: '这个 OAuth App 没开 Device Flow：在应用设置里勾上 Enable Device Flow' };
  if ((r && r.status) === 404) return { status: 'disabled', message: 'GitHub 没开 Device Flow，或 client_id 不存在' };
  if (!(r && r.json)) return { status: 'error', message: '连不上 GitHub（网络或代理问题）' };
  return { status: 'error', message: String(j.error_description || err || '未知错误') };
}

function createClient({ request = postJson } = {}) {
  /**
   * 第一步：申请设备码。
   * @param {{clientId:string, scope?:string}} o
   */
  async function start({ clientId, scope = 'repo' } = {}) {
    const id = String(clientId || '').trim();
    if (!id) return { ok: false, status: 'no_client', message: '还需要一个 OAuth App 的 Client ID（一次性，见下面的说明）' };
    const r = await request(DEVICE_CODE_URL, { client_id: id, scope });
    const j = (r && r.json) || {};
    if (!j.device_code || !j.user_code) {
      const t = readTokenResponse(r);
      return { ok: false, status: t.status === 'ok' ? 'error' : t.status, message: t.message || '申请验证码失败' };
    }
    return {
      ok: true,
      status: 'waiting',
      deviceCode: String(j.device_code),
      userCode: String(j.user_code),
      verify: String(j.verification_uri || VERIFY_URL),
      interval: Math.max(5, Number(j.interval) || 5),
      expiresIn: Math.max(60, Number(j.expires_in) || 900),
      message: `打开 ${String(j.verification_uri || VERIFY_URL)}，输入 ${String(j.user_code)}`,
    };
  }

  /**
   * 第二步：轮询一次。由渲染层按 interval 调用（主进程一次只发一个请求）。
   * @param {{clientId:string, deviceCode:string}} o
   */
  async function pollOnce({ clientId, deviceCode } = {}) {
    const id = String(clientId || '').trim();
    const dc = String(deviceCode || '').trim();
    if (!id || !dc) return { status: 'error', message: '缺少 client_id 或 device_code' };
    const r = await request(TOKEN_URL, { client_id: id, device_code: dc, grant_type: GRANT });
    return readTokenResponse(r);
  }

  return { start, pollOnce };
}

const def = createClient();

module.exports = {
  DEVICE_CODE_URL,
  TOKEN_URL,
  VERIFY_URL,
  createClient,
  readTokenResponse,
  start: def.start,
  pollOnce: def.pollOnce,
};
