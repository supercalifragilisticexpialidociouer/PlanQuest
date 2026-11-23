/* 测试：AI 闲聊雷达 UI —— 建房间发消息，验证徽章/统计/开关
 * 用法：node dev-tests/test-ai-chat-ui.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 9228;
const UDATA = 'aiU-' + Date.now().toString(36);
let child = null;
let ws = null;
let msgId = 0;
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve([]); } });
    }).on('error', reject);
  });
}

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      const page = list.find((t) => t.type === 'page' && /index\.html/i.test(t.url)) || list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('CDP 页面未找到');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WS 连接失败'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    };
  });
}

async function evalJs(expr) {
  const id = ++msgId;
  const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  const r = await p;
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const udir = path.join(os.homedir(), 'AppData', 'Roaming', 'PlanQuest-' + UDATA);
  fs.rmSync(udir, { recursive: true, force: true });
  const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = { ...process.env, PQ_USERDATA: UDATA, PQ_EYE_INT_MS: '3600000' };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], { cwd: root, env, stdio: 'ignore' });

  const page = await findPage();
  await connect(page.webSocketDebuggerUrl);
  await sleep(2500);

  // 建房间（房主）
  const created = await evalJs(`api.roomCreate({ name: '王小明', avatar: '🙂' })`);
  check('创建自习房', created && created.ok === true, created);
  await evalJs(`(async () => { state = await api.getState(); switchView('study'); return true; })()`);
  await sleep(600);

  // 闲聊雷达已改成「强制常开、不给关」：不应再有关闭开关，只保留统计条
  const bar = await evalJs(`({ toggle: !!document.querySelector('#aichat-toggle'), stat: document.querySelector('#aichat-stat')?.textContent, on: aiChatOn })`);
  check('闲聊雷达统计条已渲染', /待机中|已判/.test(bar.stat || ''), bar);
  check('闲聊雷达强制常开（无关闭开关）', bar.toggle === false && bar.on === true, bar);

  // 发三条消息，等 AI 判定
  await evalJs(`(async () => {
    await api.roomChat('哈哈哈哈这个视频笑死我了，太好笑了');
    await api.roomChat('车间设备的保养记录我整理好了，明天发你');
    await api.roomChat('兄弟们上号，今晚通宵');
    return true;
  })()`);
  await sleep(4000);

  const ui = await evalJs(`({
    lines: document.querySelectorAll('#chat-list .chat-line[data-cid]').length,
    badges: Array.from(document.querySelectorAll('#chat-list .chat-badge')).map((e) => e.textContent.trim()).filter(Boolean),
    stat: document.querySelector('#aichat-stat')?.textContent,
    statObj: aiChatStat,
  })`);
  check('聊天列表有消息', ui.lines >= 3, ui.lines);
  check('出现 AI 判定徽章', ui.badges.length >= 2, ui.badges);
  check('统计条已更新', /已判 \d+ 条/.test(ui.stat || ''), ui.stat);
  check('统计对象有闲聊计数', ui.statObj && ui.statObj.fish >= 1, ui.statObj);

  // 强制常开：aiChatOn 不可被关，徽章持续存在
  const keep = await evalJs(`(() => {
    return { on: aiChatOn, badgeCount: document.querySelectorAll('#chat-list .chat-badge').length };
  })()`);
  check('雷达保持常开且徽章仍在', keep.on === true && keep.badgeCount >= 2, keep);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  child.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('ERR', e.message);
  if (child) child.kill();
  process.exit(1);
});
