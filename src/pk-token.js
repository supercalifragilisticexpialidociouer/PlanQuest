/* PlanQuest · GitHub token 自动获取
 *
 * 手动往设置里粘 token 是个坑：容易贴错、容易顺手发给别人、换机器还得再贴一遍。
 * 这里按「本机已有的凭据」自动找，找到就用，找不到才让人登录一次。
 *
 * 顺序（先正式后兜底）：
 *   1. 环境变量 GITHUB_TOKEN / GH_TOKEN   —— CI、Actions、命令行启动都走这条
 *   2. 设置里存过的 token                  —— 官方 OAuth 登录拿到的（首选的人工来源）
 *   3. `gh auth token`                    —— 本机装过 GitHub CLI 并登录过
 *   4. `git credential fill`              —— 系统凭据管理器里存过 github.com
 *
 * 只读，不写任何凭据；返回值里带 mask，绝不把完整 token 交给渲染层。
 */
'use strict';

const { execFileSync } = require('node:child_process');

const CACHE_MS = 5 * 60e3;
let cache = { at: 0, token: '', source: 'none', detail: '' };

function looksLikeToken(s) {
  const t = String(s || '').trim();
  if (t.length < 20 || t.length > 200) return false;
  if (/\s/.test(t)) return false;
  /* gh*_ 前缀的新式 token、github_pat_、以及 40 位十六进制的老 token 都接受 */
  return /^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|[0-9a-f]{40})$/i.test(t);
}

function shell(file, args, input, env) {
  return execFileSync(file, args, {
    timeout: 4000,
    windowsHide: true,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      /* 关键：Git Credential Manager 默认会弹 GitHub 登录窗。
       * 后台读一次凭据就把用户拽去登录，体验很糟，这里直接禁掉交互。 */
      GCM_INTERACTIVE: 'never',
      GIT_ASKPASS: 'echo',
      SSH_ASKPASS: 'echo',
      ...(env || {}),
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}

function fromEnv() {
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT']) {
    const v = String(process.env[k] || '').trim();
    if (looksLikeToken(v)) return { token: v, source: 'env', detail: `环境变量 ${k}` };
  }
  return null;
}

function fromGh() {
  try {
    const v = String(shell('gh', ['auth', 'token']) || '').trim();
    if (looksLikeToken(v)) return { token: v, source: 'gh', detail: 'GitHub CLI 已登录' };
  } catch (_) {
    /* 没装 gh 或者没登录，继续往下找 */
  }
  return null;
}

function fromGitCredential() {
  try {
    const out = String(
      shell('git', ['credential', 'fill'], 'protocol=https\nhost=github.com\n\n') || ''
    );
    const line = out.split(/\r?\n/).find((l) => l.startsWith('password='));
    const v = line ? line.slice('password='.length).trim() : '';
    if (looksLikeToken(v)) return { token: v, source: 'git', detail: '系统 git 凭据' };
  } catch (_) {
    /* 没有 helper 或者终端不允许交互，跳过 */
  }
  return null;
}

/**
 * @param {{stored?:string, force?:boolean}} o
 * @returns {{token:string, source:'env'|'gh'|'git'|'stored'|'none', detail:string, masked:string, hint:string}}
 */
function resolve(o = {}) {
  const now = Date.now();
  /* deep=false（默认）：只读环境变量和设置里存过的 token，绝不碰 gh / git 凭据。
   * 这是为了避免「一进设置页就弹 GitHub 登录窗」——读系统凭据必须由用户主动点「自动查找」。 */
  const deep = o.deep === true;
  const storedNow = String(o.stored || '').trim();
  /* 设置里刚登录拿到 token 时不要用旧缓存（否则会继续显示 gh/git 的来源） */
  const stale = storedNow && cache.source !== 'stored';
  if (!o.force && !stale && cache.at && now - cache.at < CACHE_MS && cache.source !== 'none') {
    return { ...cache, masked: mask(cache.token), hint: '' };
  }
  const found = fromEnv();
  if (found) {
    cache = { at: now, token: found.token, source: found.source, detail: found.detail };
    return { ...cache, masked: mask(found.token), hint: '' };
  }
  /* 官方 OAuth 拿到的 token 存于设置里：优先级高于「读本机 CLI」，
     因为它是用户明确授权给这个应用的那一把 */
  const stored = String(o.stored || '').trim();
  if (looksLikeToken(stored)) {
    cache = { at: now, token: stored, source: 'stored', detail: '已用 GitHub 官方登录授权' };
    return { ...cache, masked: mask(stored), hint: '' };
  }
  const local = deep ? (fromGh() || fromGitCredential()) : null;
  if (local) {
    cache = { at: now, token: local.token, source: local.source, detail: local.detail };
    return { ...cache, masked: mask(local.token), hint: '' };
  }
  cache = { at: 0, token: '', source: 'none', detail: '' };
  return {
    token: '',
    source: 'none',
    detail: '',
    masked: '',
    hint: deep
      ? '本机没找到现成凭据。点「用 GitHub 登录」走官方授权（不用装任何东西）。'
      : '还没登录。点「用 GitHub 登录」走官方授权；想让我先翻一遍本机 gh / git 凭据，点「自动查找」。',
  };
}

function mask(t) {
  const s = String(t || '');
  if (s.length < 12) return s ? '****' : '';
  return s.slice(0, 6) + '****' + s.slice(-4);
}

/** 给设置页看的：只报来源和掩码，不报完整 token */
function status(stored, deep) {
  const r = resolve({ stored, force: false, deep: deep === true });
  return {
    ok: !!r.token,
    source: r.source,
    detail: r.detail,
    masked: r.masked,
    hint: r.hint,
  };
}

function clear() {
  cache = { at: 0, token: '', source: 'none', detail: '' };
}

module.exports = { resolve, status, clear, looksLikeToken, mask };
