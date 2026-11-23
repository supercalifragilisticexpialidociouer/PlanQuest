/* 自习房「往下拽」探针：进房后采样滚动位置与 DOM 变动，定位是谁在拖动
 * 用法：node dev-tests/debug-room-scroll.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9361;
const TAG = 'scr-' + Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (_) { resolve([]); } });
    }).on('error', reject);
  });
}
async function findPage(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json`);
      const page = list.find((t) => t.type === 'page' && /index\.html/i.test(t.url)) || list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('CDP 页面未找到');
}
function makeClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const st = { ws: null, id: 0, pending: new Map() };
    const ws = new WebSocket(wsUrl);
    st.ws = ws;
    ws.onopen = () => resolve(st);
    ws.onerror = () => reject(new Error('WS 连接失败'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && st.pending.has(m.id)) {
        const { resolve: r, reject: j } = st.pending.get(m.id);
        st.pending.delete(m.id);
        if (m.error) j(new Error(m.error.message));
        else r(m.result);
      }
    };
  });
}
async function evalJs(c, expr) {
  const id = ++c.id;
  const p = new Promise((resolve, reject) => c.pending.set(id, { resolve, reject }));
  c.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  const r = await p;
  if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}
function launch() {
  const udir = path.join(os.homedir(), 'AppData', 'Roaming', 'PlanQuest-' + TAG);
  fs.rmSync(udir, { recursive: true, force: true });
  const bin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = { ...process.env, PQ_USERDATA: TAG, PQ_EYE_INT_MS: '3600000' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return spawn(bin, ['.', '--force-new', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' });
}

async function main() {
  const proc = launch();
  try {
    const A = await makeClient((await findPage(PORT)).webSocketDebuggerUrl);
    await sleep(2500);

    // 建自习房并进入房间视图
    const joined = await evalJs(A, `(async () => {
      switchView('study');
      await new Promise(r => setTimeout(r, 400));
      const btn = document.getElementById('room-create');
      if (!btn) return 'no-create-btn';
      btn.click();
      await new Promise(r => setTimeout(r, 1500));
      return { roomJoined: typeof roomJoined !== 'undefined' ? roomJoined : 'n/a', hasChat: !!document.getElementById('chat-input') };
    })()`);
    await evalJs(A, `(() => {
      // 通过真实 api 发聊天：roomChat 会经房主中继回到 'chat' 事件
      window.__roomChat = (text) => { try { api.roomChat({ text, mid: 'probe-' + Date.now() }); } catch (e) { console.log(e.message); } };
      return true;
    })()`);
    console.log('建房结果:', JSON.stringify(joined));
    if (joined === 'no-create-btn') throw new Error('没找到创建房间按钮');

    // 场景 1：不打字（模拟读聊天），把窗口滚到中部，采样 12 秒
    await evalJs(A, `(() => {
      document.querySelectorAll('#chat-input').forEach(el => el.blur());
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      window.scrollTo(0, 300);
      return { y: window.scrollY, docH: document.body.scrollHeight };
    })()`);
    let prev = null;
    const t0 = Date.now();
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const s = await evalJs(A, `(() => ({
        y: window.scrollY,
        chatTop: (document.getElementById('chat-list')||{}).scrollTop,
        viewFirst: (document.getElementById('view')||{}).firstElementChild ? 'x' : '-',
        gridMark: (() => { const g = document.getElementById('member-grid'); if (!g || !g.firstElementChild) return '-'; if (!g.firstElementChild.__probe) g.firstElementChild.__probe = 1; return g.firstElementChild.__probe ? 'mark' : 'REBUILT'; })(),
        chatListMark: (() => { const g = document.getElementById('chat-list'); if (!g || !g.firstElementChild) return '-'; if (!g.firstElementChild.__probe) g.firstElementChild.__probe = 1; return g.firstElementChild.__probe ? 'mark' : 'REBUILT'; })(),
        active: (document.activeElement||{}).id || (document.activeElement||{}).tagName,
        chatLines: document.querySelectorAll('#chat-list .chat-line').length
      }))()`);
      const key = JSON.stringify(s);
      if (key !== prev) {
        console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s]`, key);
        prev = key;
      }
    }

    // 场景 2：打字中（聚焦聊天框），再采样 12 秒
    console.log('--- 场景 2：聚焦聊天输入框 ---');
    await evalJs(A, `(() => {
      const el = document.getElementById('chat-input');
      el.value = '正在打字测试';
      el.focus();
      el.setSelectionRange(6, 6);
      window.scrollTo(0, 300);
      return window.scrollY;
    })()`);
    prev = null;
    const t1 = Date.now();
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const s = await evalJs(A, `(() => {
        const el = document.getElementById('chat-input');
        return {
          y: window.scrollY,
          val: el ? el.value : '-',
          focused: document.activeElement === el,
          gridMark: (() => { const g = document.getElementById('member-grid'); if (!g || !g.firstElementChild) return '-'; if (!g.firstElementChild.__probe) g.firstElementChild.__probe = 1; return g.firstElementChild.__probe ? 'mark' : 'REBUILT'; })(),
        };
      })()`);
      const key = JSON.stringify(s);
      if (key !== prev) {
        console.log(`[t+${((Date.now() - t1) / 1000).toFixed(1)}s]`, key);
        prev = key;
      }
    }
    // 场景 3：读历史——把 chat-list 滚回顶部，然后由房主中继发一条消息
    console.log('--- 场景 3：读历史时来消息 ---');
    const sc3 = await evalJs(A, `(async () => {
      const list = document.getElementById('chat-list');
      for (let i = 0; i < 8; i++) { window.api && 0; }
      // 造 5 条历史消息撑出滚动空间
      for (let i = 0; i < 5; i++) pushChat({ id: 'p' + i, from: '测试' + i, text: '历史消息 ' + i, at: Date.now() });
      await new Promise(r => setTimeout(r, 200));
      list.scrollTop = 0; // 用户滚到顶看历史
      const before = list.scrollTop;
      // 同房间一条真实消息（走房间事件链路）
      window.__roomChat && window.__roomChat('有人发了一条新消息');
      await new Promise(r => setTimeout(r, 400));
      return { before, after: list.scrollTop, lines: list.querySelectorAll('.chat-line').length };
    })()`);
    console.log('读历史被拽回底部?', JSON.stringify(sc3));
    // 场景 4：打字中对方来消息（chat 输入框会被波及吗）
    const sc4 = await evalJs(A, `(async () => {
      const el = document.getElementById('chat-input');
      el.focus(); el.setSelectionRange(3, 3);
      const list = document.getElementById('chat-list');
      list.scrollTop = 0;
      const yBefore = window.scrollY;
      pushChat({ id: 'p9', from: '测试', text: '打字中来消息', at: Date.now() });
      await new Promise(r => setTimeout(r, 300));
      return { stillFocused: document.activeElement === el, val: el.value, chatTop: list.scrollTop, yAfter: window.scrollY };
    })()`);
    console.log('打字中来消息:', JSON.stringify(sc4));
    console.log('PROBE_DONE');
  } finally {
    proc.kill();
    await sleep(800);
    try { fs.rmSync(path.join(os.homedir(), 'AppData', 'Roaming', 'PlanQuest-' + TAG), { recursive: true, force: true }); } catch (_) {}
  }
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
