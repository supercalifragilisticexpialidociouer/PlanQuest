/* 网页/安卓 共用加载路径测试：自训练（文字输出层 + 画面校准）与强制开启 UI
 * 用法：node dev-tests/test-web-chat.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WEB_PORT = 8796;
const CDP_PORT = 9234;
let chrome = null;
let server = null;
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
      const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json`);
      const page = list.find((t) => t.type === 'page');
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
  const webDir = path.join(root, 'web');
  server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const fp = path.join(webDir, urlPath === '/' ? 'index.html' : urlPath);
    if (!fp.startsWith(webDir)) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('nf'); }
      const ext = path.extname(fp).toLowerCase();
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.onnx': 'application/octet-stream', '.wasm': 'application/wasm', '.mjs': 'text/javascript', '.txt': 'text/plain' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(buf);
    });
  }).listen(WEB_PORT);

  const chromeBin = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const prof = path.join(os.tmpdir(), 'pq-web-train-' + Date.now());
  chrome = spawn(chromeBin, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${prof}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `http://127.0.0.1:${WEB_PORT}/`,
  ], { stdio: 'ignore' });

  const page = await findPage();
  await connect(page.webSocketDebuggerUrl);
  await sleep(3000);


  const env = await evalJs(`({
    train: typeof window.AITrain,
    chat: typeof window.AIChat,
    watch: typeof window.AIWatch,
    db: typeof window.PQCloud?.database === 'function',
    cloudReady: !!(window.PQCloud && PQCloud.database && PQCloud.database())
  })`);
  check('AITrain 已加载（网页版）', env.train === 'object', env);
  check('pq-cloud 暴露 database()', env.db === true, env);
  check('未登录时云端不可用', env.cloudReady === false, env);

  const out = await evalJs(`(async () => {
    await AIChat.preload();
    const WORK = ${JSON.stringify(WORK)};
    const FISH = ${JSON.stringify(FISH)};
    WORK.forEach((t) => AITrain.addTextSample(t, 0));
    FISH.forEach((t) => AITrain.addTextSample(t, 1));
    const c0 = AITrain.counts();
    const t0 = performance.now();
    const rt = await AITrain.trainText();
    const textMs = Math.round(performance.now() - t0);
    for (let i = 0; i < 12; i++) AITrain.addImageSample({ d: -0.5, thumb: '' }, 1);
    for (let i = 0; i < 12; i++) AITrain.addImageSample({ d: -2.0, thumb: '' }, 0);
    const ri = AITrain.trainImage();
    const probe = await AIChat.classify('兄弟们上号今晚通宵');
    return {
      c0, textMs,
      textOk: rt.ok, textMsg: rt.message || '', acc: rt.after ? rt.after.acc : null, before: rt.before ? rt.before.accTrain : null,
      textActive: AITrain.activeId('text'),
      imgOk: ri.ok, imgMsg: ri.message || '', imgBefore: ri.before ? ri.before.acc : null, imgAfter: ri.after ? ri.after.acc : null,
      imgActive: AITrain.activeId('image'), calib: window.AIWatch.calib(),
      probe: probe.label,
      info: AITrain.info(),
    };
  })()`);
  check('文字训练成功（网页 fetch 路径）', out.textOk === true, out.textMsg);
  check(`训练集准确率 ${Math.round(out.before * 100)}% → ${Math.round(out.acc * 100)}%（${out.textMs}ms）`, out.acc >= out.before, { ms: out.textMs });
  check('训练后自动启用我的文字模型', out.textActive !== 'official', out.textActive);
  check('画面校准训练成功', out.imgOk === true, out.imgMsg);
  check(`校准准确率 ${Math.round(out.imgBefore * 100)}% → ${Math.round(out.imgAfter * 100)}%`, out.imgAfter > out.imgBefore, { imgBefore: out.imgBefore, imgAfter: out.imgAfter });
  check('校准已装入 AIWatch', !!(out.calib && out.calib.T > 0), out.calib);
  check('自训练后判定仍正常', ['fish', 'work', 'uncertain'].includes(out.probe), out.probe);

  const ui = await evalJs(`(async () => {
    currentView = 'settings';
    renderSettings();
    await new Promise((r) => setTimeout(r, 300));
    return {
      hasToggle: !!document.querySelector('#aichat-toggle'),
      panel: !!document.querySelector('.ai-tr-grid'),
      trainBtn: !!document.querySelector('#ai-tr-text'),
      imgBtn: !!document.querySelector('#ai-tr-image'),
      syncBtn: !!document.querySelector('#ai-tr-sync'),
      sel: !!document.querySelector('#ai-tr-text-sel'),
      hasFb: !!document.querySelector('#ai-fb'),
      badgeFn: typeof onChatBadgeClick === 'function',
      watchFn: typeof window.onAIWatched === 'function',
    };
  })()`);
  check('闲聊雷达不再有开关按钮', ui.hasToggle === false, ui);
  check('设置页自训练面板已渲染', ui.panel && ui.trainBtn && ui.imgBtn && ui.syncBtn && ui.sel, ui);
  check('纠错入口已接好（徽章点击 + 抓包回调）', ui.badgeFn && ui.watchFn, ui);
  // 网页版没有局域网房间（roomCreate 是桩），这里用假房间把房间视图渲染出来验证纠错条
  const fb = await evalJs(`(() => {
    try {
      state = Object.assign({}, state, { room: { inRoom: true, type: 'study', myId: 'me', code: 'TEST' } });
      renderStudy();
      return { ok: true, hasFb: !!document.querySelector('#ai-fb'), force: !!document.querySelector('.ai-force'), aiBtn: document.querySelector('#ai-toggle')?.textContent || '' };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  })()`);
  check('房间视图仍能渲染（含抓包纠错条与强制标记）', fb.ok === true && fb.hasFb === true && fb.force === true, fb);

  check('AI 盯学按钮为常开态', /常开/.test(fb.aiBtn || ''), fb.aiBtn);

  const syncMsg = await evalJs(`(async () => {
    AITrain.setConfig({ cloud: true });
    const r = await AITrain.sync();
    AITrain.setConfig({ cloud: false });
    return r;
  })()`);
  check('未登录时同步给出明确提示', syncMsg.ok === false && /登录/.test(syncMsg.message), syncMsg);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (chrome) chrome.kill();
  server.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('ERR', e.message);
  if (chrome) chrome.kill();
  if (server) server.close();
  process.exit(1);
});

const WORK = [
  '车间设备的保养记录我整理好了，明天发你',
  '今晚加班到十点，方案还得再改一版',
  '这份周报的第三部分数据我重新核对过了',
  '明天上午九点开会，材料我今天下班前发群里',
  '图纸的尺寸标注有几个地方需要确认一下',
  '安全检查的整改清单我已经按部门分好了',
  '这一段代码我再优化一下，接口响应太慢',
  '背完这一单元的单词，做两篇阅读',
  '下午把实验数据跑完，晚上写结论部分',
  '设备台账更新到最新版本了，麻烦你审一下',
  '这个月的工作计划我列了三条重点',
  '会议纪要发你邮箱了，重点标了黄色',
];
const FISH = [
  '哈哈哈哈这个视频笑死我了，太好笑了',
  '兄弟们上号，今晚通宵',
  '刚刷到一个特别搞笑的段子，你们看',
  '摸鱼摸鱼，老板不在快来看直播',
  '这剧真的太上头了，一集接一集停不下来',
  '谁在打游戏，带我一把',
  '哈哈哈你看这个猫，太逗了',
  '无聊死了，咱们聊点八卦吧',
  '刚吃完一大袋薯片，太爽了',
  '刷短视频刷到凌晨两点，起不来了',
  '快来组队，今晚开黑',
  '这个主播太搞笑了，笑到肚子疼',
];
