'use strict';
/* 生成 R2 用的版本清单 dist/version.json
 *
 *   node tools/build-manifest.js --base https://dl.example.com/planquest
 *
 * 只做本地计算（size / sha256），不上传、不联网。
 * 把 version.json + 版本包 + 单文件安装器一起传到 R2 的同一个前缀下即可，
 * 客户端只认 version.json 里的绝对直链，不依赖目录结构。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function arg(k, d) {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
}
const BASE = String(arg('--base', 'https://dl.example.com/planquest')).replace(/\/+$/, '');
const VER = String(arg('--ver', pkg.version));
const CHANNEL = String(arg('--channel', 'stable'));
const NOTES = String(arg('--notes', '安装助手全中文向导；修复版本号拼进下载 URL 导致所有源失败；GitHub API 资产源优先；每个源同时提供主包与备份 ZIP；ZIP 原样完整解压、快捷方式指向真实 exe 与软件图标；ZIP 无用户数据（初始状态）'));
/* base 已经是 releases/download/<tag> 时不要再拼一层版本号 */
const BASE_HAS_TAG = /\/releases\/download\/[^/]+$/.test(BASE);
function assetUrl(file) {
  return `${BASE_HAS_TAG ? BASE : `${BASE}/${VER}`}/${file}`;
}

function stat(file, assetNameOverride) {
  const p = path.join(DIST, file);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  const rel = file.replace(/\\/g, '/');
  /* 发布包在 GitHub Release 里是平铺的，不带 releases/ 前缀；
     安装助手用纯 ASCII 资产名，避免客户端 URL 出现未转义中文。 */
  const assetName = assetNameOverride ||
    (rel.startsWith('releases/') ? rel.slice('releases/'.length) : rel);
  return {
    file: rel,
    url: assetUrl(assetName),
    size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

/* 可选大模型：一律是官网直链，不经过 R2、不进主包。
 * 勾了才下，不勾就一个字节都不动（客户端与安装器都按这个清单执行）。 */
const COMPONENTS = [
  {
    id: 'ollama',
    name: 'Ollama 绿色版 + Qwen2.5 3B',
    official: 'https://github.com/ollama/ollama/releases/download/v0.40.17/ollama-windows-amd64.zip',
    file: 'ollama-windows-amd64.zip',
    size: 1618522644,
    sha256: null, // 以官网同目录 sha256sum.txt 为准，不在清单里编造
    checksumUrl: 'https://github.com/ollama/ollama/releases/download/v0.40.17/sha256sum.txt',
    dest: '%LOCALAPPDATA%\\PlanQuest\\components\\ollama',
    admin: false,
    green: true,
    modelPull: 'ollama pull qwen2.5:3b',
    modelSize: 1930000000,
    note: '官网 Windows 绿色 zip，解压即用；模型另由 ollama pull 拉取。无独显时 CPU 推理要等几十秒。',
  },
  {
    id: 'melotts',
    name: 'MeloTTS（本地中文语音合成）',
    official: 'https://github.com/myshell-ai/MeloTTS/archive/refs/heads/main.zip',
    file: 'MeloTTS-main.zip',
    size: null,
    sha256: null,
    dest: '%LOCALAPPDATA%\\PlanQuest\\components\\melotts',
    admin: false,
    green: false,
    runnable: false,
    requires: 'Python <= 3.10 + torch<2.0',
    note: '官网只有源码，没有 Windows 运行包；本机 Python 3.13 装不上 torch 1.x，勾了也只会得到源码。',
  },
];

const zip = stat('PlanQuest-win64-portable.zip');
const exe = stat(path.join('releases', `PlanQuest-${VER}-setup.exe`));
const assistant = stat(path.join('releases', 'PlanQuest-安装助手.exe'), 'PlanQuest-install-assistant.exe');
const portableBackup = stat('releases/PlanQuest-win64-portable-backup.zip');

const manifest = {
  schema: 1,
  version: VER,
  channel: CHANNEL,
  releasedAt: new Date().toISOString().slice(0, 10),
  notes: NOTES,
  base: BASE,
  /* 绿色版：不提权、只解压、不写注册表、不改系统 */
  installer: {
    admin: false,
    action: 'unpack-only',
    ...(exe || { file: `PlanQuest-${VER}-setup.exe`, url: assetUrl(`PlanQuest-${VER}-setup.exe`), size: null, sha256: null, built: false }),
    ...(exe ? { built: true } : {}),
  },
  /* 在线安装助手：全中文向导；ZIP 原样完整解压；快捷方式指向真实 exe + 软件图标 */
  assistant: {
    admin: false,
    action: 'bootstrap',
    ...(assistant || { file: 'PlanQuest-安装助手.exe', url: assetUrl('PlanQuest-安装助手.exe'), size: null, sha256: null, built: false }),
    ...(assistant ? { built: true } : {}),
  },
  portable: zip || null,
  /* 备份 ZIP：与 portable 字节一致，供其他源/备用直链使用 */
  portableBackup: portableBackup || null,
  /* 数据不用迁移：userData 与 exe 目录解耦 */
  data: {
    path: '%APPDATA%\\PlanQuest\\data.json',
    migration: 'none',
    note: '换任何绿色版目录都自动沿用；安装器不碰这个目录。',
  },
  components: COMPONENTS,
  policy: {
    defaultSelected: [],
    downloadFrom: 'official',
    offlineWithoutComponents: true,
    autoStart: 'app-only', // 注册表启动项只能由应用内开关写入，安装器不代劳
    autoStartScope: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  },
};

fs.mkdirSync(path.join(DIST, 'releases'), { recursive: true });
const out = path.join(DIST, 'version.json');
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('MANIFEST_OK', out);
console.log('  version =', VER, ' base =', BASE);
console.log('  portable =', zip ? `${zip.size} bytes / ${zip.sha256.slice(0, 16)}…` : '未找到 ZIP');
console.log('  installer =', exe ? `${exe.size} bytes / ${exe.sha256.slice(0, 16)}…` : '未编译（built:false，跑 ISCC 后重跑本脚本）');
console.log('  assistant =', assistant ? `${assistant.size} bytes / ${assistant.sha256.slice(0, 16)}…` : '未编译');
console.log('  components =', COMPONENTS.map((c) => c.id).join(', '), '（默认全不勾）');
