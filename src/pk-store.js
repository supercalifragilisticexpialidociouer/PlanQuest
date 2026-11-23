/* PlanQuest · PK 布告栏：私有 GitHub 仓库（主 + 备双写）
 *
 * 为什么不用 Gist / 公共暂存盘：
 *   - 全团共用一个 JSON → 50 个军团同时上报，最后写的人覆盖前面 49 个（写冲突）；
 *   - 公共暂存盘会过期，而且谁都能读。
 *
 * 现在的做法：
 *   - 一个军团一个文件（legions/<军团码>.json），各写各的，天然不冲突；
 *   - 仓库私有，只有持 token 的军团主能读写；
 *   - 写回带 sha（乐观锁），被抢先改过就重读再写，不静默覆盖；
 *   - 主仓 + 备仓双写，读的时候两边对比：不一致 ≠ 出错，但要告警（可能被单边篡改）；
 *   - 每小时把档案快照到备仓 snapshots/，被改坏了能回滚。
 *
 * 这里只做 HTTP 与仓库布局，不碰业务逻辑，便于单独测。
 */
'use strict';

const API = 'https://api.github.com';
const UA = 'PlanQuest/2.4 (legion-pk)';
const TIMEOUT = 20000;

const tokenSource = require('./pk-token');

let cfgGetter = () => ({});

function init(getCfg) {
  if (typeof getCfg === 'function') cfgGetter = getCfg;
}

function normTarget(t) {
  const o = t || {};
  return {
    owner: String(o.owner || '').trim(),
    repo: String(o.repo || '').trim(),
    branch: String(o.branch || 'main').trim() || 'main',
    token: String(o.token || '').trim(),
  };
}

function cfg() {
  const c = (cfgGetter && cfgGetter()) || {};
  const main = normTarget(c);
  /* token 留空不再等于「不能用」：先去本机找（环境变量 / gh / git 凭据） */
  if (!main.token) {
    const r = tokenSource.resolve({ stored: '' });
    if (r.token) main.token = r.token;
  }
  const backup = c.backup ? normTarget({ token: main.token, ...c.backup }) : null;
  return { ...main, backup: backup && backup.repo ? backup : null };
}

function configured(t) {
  const c = t || cfg();
  return !!(c.owner && c.repo && c.token);
}

function dualEnabled() {
  const c = cfg();
  return !!(c.backup && c.backup.repo);
}

function describe() {
  const c = cfg();
  if (!configured(c)) return '未配置私有仓库（军团主填 owner/repo 即可，token 留空会自动读取本机凭据）';
  return `${c.owner}/${c.repo}@${c.branch}${c.backup ? ' + 备仓 ' + c.backup.repo : ''}`;
}

function headers(t) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + t.token,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
  };
}

const encPath = (p) =>
  String(p)
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');

function urlOf(t, path, withRef) {
  const base = `${API}/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/contents/${encPath(path)}`;
  return withRef ? `${base}?ref=${encodeURIComponent(t.branch)}` : base;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64').toString('utf8');

/* ---------------- 单目标读写 ---------------- */

async function readAt(t, path) {
  if (!configured(t)) return { ok: false, missing: true, message: '仓库未配置' };
  try {
    const r = await fetch(urlOf(t, path, true), { headers: headers(t), signal: AbortSignal.timeout(TIMEOUT) });
    if (r.status === 404) return { ok: false, missing: true, message: '文件还不存在' };
    if (!r.ok) return { ok: false, message: '读取失败 HTTP ' + r.status };
    const j = await r.json();
    if (!j || j.type !== 'file') return { ok: false, missing: true, message: '不是文件' };
    const txt = j.encoding === 'base64' ? unb64(j.content) : String(j.content || '');
    let data = null;
    try {
      data = JSON.parse(txt);
    } catch (_) {
      return { ok: false, sha: j.sha, message: '文件不是合法 JSON' };
    }
    return { ok: true, data, sha: j.sha };
  } catch (e) {
    return { ok: false, message: '网络错误：' + String((e && e.message) || e) };
  }
}

async function writeAt(t, path, data, opts) {
  const o = opts || {};
  if (!configured(t)) return { ok: false, message: '仓库未配置' };
  const body = {
    message: String(o.message || 'pk: update ' + path).slice(0, 200),
    content: b64(JSON.stringify(data, null, 2)),
    branch: t.branch,
  };
  if (o.sha) body.sha = o.sha;
  try {
    const r = await fetch(urlOf(t, path, false), {
      method: 'PUT',
      headers: { ...headers(t), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (r.status === 409 || r.status === 422) return { ok: false, conflict: true, message: '文件已被别人改过' };
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, message: '写入失败 HTTP ' + r.status + (txt ? ' · ' + txt.slice(0, 120) : '') };
    }
    const j = await r.json().catch(() => null);
    return { ok: true, sha: (j && j.content && j.content.sha) || '' };
  } catch (e) {
    return { ok: false, message: '网络错误：' + String((e && e.message) || e) };
  }
}

async function listAt(t, dir) {
  if (!configured(t)) return { ok: false, list: [] };
  try {
    const r = await fetch(urlOf(t, dir, true), { headers: headers(t), signal: AbortSignal.timeout(TIMEOUT) });
    if (r.status === 404) return { ok: true, list: [] };
    if (!r.ok) return { ok: false, list: [], message: '列目录失败 HTTP ' + r.status };
    const j = await r.json();
    const list = Array.isArray(j)
      ? j.filter((x) => x && x.type === 'file' && /\.json$/i.test(x.name)).map((x) => ({ name: x.name, path: x.path, sha: x.sha }))
      : [];
    return { ok: true, list };
  } catch (_) {
    return { ok: false, list: [] };
  }
}

/* ---------------- 对外：带冗余的读写 ---------------- */

/* 读：主仓 + 备仓各读一次。两边都在但内容不同 → mismatch，交给上层决定信谁。 */
async function readFile(path) {
  const c = cfg();
  const main = await readAt(c, path);
  if (!dualEnabled()) return { ...main, source: 'main', mismatch: false };

  const bak = await readAt(c.backup, path);
  const both = main.ok && bak.ok;
  const mismatch = both && JSON.stringify(main.data) !== JSON.stringify(bak.data);
  const r = main.ok ? main : bak;
  return {
    ...r,
    source: main.ok ? 'main' : bak.ok ? 'backup' : 'none',
    mismatch,
    main: main.ok ? { data: main.data } : null,
    backup: bak.ok ? { data: bak.data } : null,
  };
}

/* 写：先主后备。备仓失败不影响主仓已经写成功的事实，但要把状态带回去。 */
async function writeFile(path, data, opts) {
  const c = cfg();
  const main = await writeAt(c, path, data, opts);
  if (!dualEnabled()) return { ...main, backupOk: null };
  const bak = await writeAt(c.backup, path, data, { ...opts, sha: '' });
  return { ...main, backupOk: !!bak.ok, backupMessage: bak.ok ? '' : bak.message };
}

/* 读-改-写：冲突时重读再试；只影响本军团这一个文件，不会踩到别人 */
async function upsert(path, build, opts) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await readFile(path);
    const next = await build(cur && cur.ok ? cur.data : null, (cur && cur.sha) || '');
    if (!next) return { ok: false, message: '没有可写的内容' };
    const w = await writeFile(path, next, { ...opts, sha: (cur && cur.sha) || '' });
    if (w.ok) return w;
    if (!w.conflict) return w;
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  return { ok: false, message: '连续冲突，稍后再试' };
}

async function listDir(dir) {
  const c = cfg();
  const r = await listAt(c, dir);
  return r;
}

/* 快照：写到备仓（没有备仓就写主仓）snapshots/<小时>/<原路径> */
async function snapshot(path, data, stamp) {
  const c = cfg();
  const target = c.backup || c;
  const key = String(stamp || new Date().toISOString().slice(0, 13)).replace(/[:]/g, '-');
  return writeAt(target, `snapshots/${key}/${path}`, data, { message: 'snapshot ' + key });
}

/* ---------------- 路径约定 ---------------- */

const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '');
const pathOfLegion = (code) => `legions/${safe(code)}.json`;
const pathOfKey = (code) => `keys/${safe(code)}.json`;
const pathOfPairing = (week) => `results/${String(week).slice(0, 10)}/pairing.json`;
const pathOfResult = (week, code) => `results/${String(week).slice(0, 10)}/${safe(code)}.json`;
const pathOfLog = (day) => `logs/${String(day).slice(0, 10)}.json`;

module.exports = {
  init,
  cfg,
  configured,
  dualEnabled,
  describe,
  readAt,
  writeAt,
  readFile,
  writeFile,
  upsert,
  listDir,
  snapshot,
  pathOfLegion,
  pathOfKey,
  pathOfPairing,
  pathOfResult,
  pathOfLog,
};
