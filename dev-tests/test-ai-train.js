/* 测试：AI 自训练（文字输出层 + 画面校准）+ 强制开启 UI
 * 用法：node dev-tests/test-ai-train.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 9233;
const UDATA = 'aiTr-' + Date.now().toString(36);
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
      res.on('end', () => {
        try {
          resolve(JSON.parse(s));
        } catch (e) {
          resolve([]);
        }
      });
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

  const loaded = await evalJs(`({
    train: typeof window.AITrain,
    cloud: typeof window.PQCloud?.database === 'function',
    chat: typeof window.AIChat,
    watch: typeof window.AIWatch
  })`);
  check('AITrain 模块已加载', loaded.train === 'object', loaded);
  check('pq-cloud 暴露 database()', loaded.cloud === true, loaded);

  /* ---------- 文字样本 ---------- */
  const addRes = await evalJs(`(() => {
    ${JSON.stringify(WORK)}.forEach((t) => AITrain.addTextSample(t, 0, '测试'));
    ${JSON.stringify(FISH)}.forEach((t) => AITrain.addTextSample(t, 1, '测试'));
    AITrain.addTextSample(${JSON.stringify(WORK[0])}, 0, '重复标注去重');
    return AITrain.counts();
  })()`);
  check(`文字样本 24 条且去重生效 (${addRes.text})`, addRes.text === 24, addRes);
  check(`正负样本各 12 条 (${addRes.textFish}/${24 - addRes.textFish})`, addRes.textFish === 12, addRes);
  check(`待上传计数 ${addRes.pending}`, addRes.pending === 24, addRes);

  /* ---------- 训练文字模型 ---------- */
  const trainRes = await evalJs(`(async () => {
    await AIChat.preload();
    const t0 = performance.now();
    const r = await AITrain.trainText();
    const ms = Math.round(performance.now() - t0);
    return {
      ok: r.ok, message: r.message || '', ms,
      acc: r.after ? r.after.acc : null,
      before: r.before ? r.before.accTrain : null,
      n: r.model ? r.model.n : 0,
      modelId: r.model ? r.model.id : '',
      active: AITrain.activeId('text'),
      models: AITrain.modelList('text').length,
    };
  })()`);
  check('文字训练成功', trainRes.ok === true, trainRes.message);
  check(`训练集准确率提升 ${(trainRes.before * 100).toFixed(0)}% → ${(trainRes.acc * 100).toFixed(0)}%`, trainRes.acc >= trainRes.before, trainRes);
  check(`训练样本数 ${trainRes.n}`, trainRes.n === 24, trainRes.n);
  check(`训练耗时 ${trainRes.ms}ms < 8000ms`, trainRes.ms < 8000, trainRes.ms);
  check('训练后自动切到我的模型', trainRes.active === trainRes.modelId, trainRes.active);
  check('模型列表里有 1 个文字模型', trainRes.models === 1, trainRes.models);

  /* ---------- 训练后的判定仍然可用 ---------- */
  const afterCls = await evalJs(`(async () => {
    const outs = [];
    for (const t of ['兄弟们上号今晚通宵', '这份周报的数据我核对过了']) outs.push((await AIChat.classify(t)).label);
    return outs;
  })()`);
  check('自训练模型仍能正常判定', afterCls.length === 2 && afterCls.every((x) => x === 'fish' || x === 'work' || x === 'uncertain'), afterCls);

  /* ---------- 纠正一条模型判错的句子 → 判定真的往正确方向走 ---------- */
  const flip = await evalJs(`(async () => {
    const probe = '笑死，这个 bug 我调了两小时终于修好了';
    const b = await AIChat.classify(probe);
    AITrain.addTextSample(probe, 0, '纠错');
    const r = await AITrain.trainText();
    const a = await AIChat.classify(probe);
    return { ok: r.ok, n: r.model ? r.model.n : 0, beforeLabel: b.label, beforeP: +b.p.toFixed(3), afterLabel: a.label, afterP: +a.p.toFixed(3) };
  })()`);
  check(
    `纠正样本后判定向「正经事」移动 (${flip.beforeLabel} ${flip.beforeP} → ${flip.afterLabel} ${flip.afterP})`,
    flip.afterP < flip.beforeP - 0.2,
    flip
  );

  /* ---------- 切回官方模型 ---------- */
  const backOfficial = await evalJs(`(() => { AITrain.setActive('text', 'official'); return AITrain.activeId('text'); })()`);
  check('可切回官方模型', backOfficial === 'official', backOfficial);

  /* ---------- 画面校准 ---------- */
  const imgRes = await evalJs(`(() => {
    // 摸鱼帧官方 d 偏小(-0.5)，认真帧 d 更小(-2.0)：官方全判成认真
    for (let i = 0; i < 12; i++) AITrain.addImageSample({ d: -0.5, thumb: 'data:image/jpeg;base64,AA' }, 1);
    for (let i = 0; i < 12; i++) AITrain.addImageSample({ d: -2.0, thumb: 'data:image/jpeg;base64,AA' }, 0);
    const c = AITrain.counts();
    const r = AITrain.trainImage();
    if (!r.ok) return { ok: false, message: r.message, c };
    AITrain.setActive('image', r.model.id);
    return {
      ok: true, c,
      before: r.before.acc, after: r.after.acc,
      T: +r.T.toFixed(3), b: +r.b.toFixed(3),
      active: AITrain.activeId('image'),
      calib: window.AIWatch.calib(),
    };
  })()`);
  check('画面样本 24 条', imgRes.c && imgRes.c.image === 24, imgRes.c);
  check('画面校准训练成功', imgRes.ok === true, imgRes.message);
  check(`校准后准确率 ${Math.round(imgRes.before * 100)}% → ${Math.round(imgRes.after * 100)}%`, imgRes.after > imgRes.before, imgRes);
  check(`学到正偏置 b>0.5 (b=${imgRes.b})`, imgRes.b > 0.5, imgRes.b);
  check('校准已装入 AIWatch', !!(imgRes.calib && imgRes.calib.T > 0), imgRes.calib);

  /* ---------- 校准对判定的实际影响 ---------- */
  const calibEffect = await evalJs(`(() => {
    const sig = (x) => 1 / (1 + Math.exp(-x));
    const c = window.AIWatch.calib();
    const officialP = sig(-0.5);
    const tunedP = sig(-0.5 / c.T + c.b);
    return { officialP: +officialP.toFixed(3), tunedP: +tunedP.toFixed(3) };
  })()`);
  check(`同一帧摸鱼概率 ${calibEffect.officialP} → ${calibEffect.tunedP}`, calibEffect.tunedP > 0.5 && calibEffect.officialP < 0.5, calibEffect);

  /* ---------- 持久化 ---------- */
  const persisted = await evalJs(`(() => {
    const fileStore = !!(window.api && window.api.aiStore);
    const raw = fileStore ? JSON.parse(window.api.aiStore.load() || '{}') : null;
    const models = (raw && raw.models) || AITrain.modelList('text').concat(AITrain.modelList('image'));
    const active = (raw && raw.active) || { text: AITrain.activeId('text'), image: AITrain.activeId('image') };
    return { fileStore, models: models.length, kinds: models.map((m) => m.kind), active };
  })()`);
  check('桌面版训练数据落盘（两个窗口共用）', persisted.fileStore === true, persisted);
  check('模型已写入本机存储', persisted.models >= 2 && persisted.kinds.includes('image'), persisted);
  check('使用中的模型也持久化', persisted.active.image && persisted.active.image !== 'official', persisted.active);

  /* ---------- 强制开启 UI ---------- */
  const forced = await evalJs(`(() => {
    const hasToggle = !!document.querySelector('#aichat-toggle');
    const r = api.roomCreate({ name: 'tester', avatar: '🙂' });
    return r.then((res) => {
      renderStudy();
      return new Promise((ok) => setTimeout(() => ok({
        hasToggle,
        forceChip: !!document.querySelector('.ai-force'),
        aiBtn: document.querySelector('#ai-toggle')?.textContent || '',
        fbBar: !!document.querySelector('#ai-fb'),
        penBox: !!document.querySelector('#aichat-pen'),
        penText: (document.querySelector('.ai-chat-pen')?.textContent || '').trim(),
        penaltyOn: aiChatPenalty,
        badgeClickable: document.querySelectorAll('.chat-badge[data-fix]').length,
      }), 400));
    });
  })()`);
  check('闲聊雷达开关按钮已移除', forced.hasToggle === false, forced);
  check('房间显示「强制开启」标记', forced.forceChip === true, forced);
  check(`AI 盯学按钮为常开态 (${forced.aiBtn})`, /常开/.test(forced.aiBtn), forced.aiBtn);
  check('抓包纠错条存在', forced.fbBar === true, forced);
  check('扣分开关已移除（强制扣分）', forced.penBox === false && forced.penaltyOn === true, forced);
  check(`扣分说明文案 (${forced.penText})`, /强制扣/.test(forced.penText), forced.penText);

  /* ---------- 设置页面板 ---------- */
  const panel = await evalJs(`(async () => {
    currentView = 'settings';
    renderSettings();
    await new Promise((r) => setTimeout(r, 300));
    const el = document.querySelector('#ai-tr-text');
    const info = AITrain.info();
    return {
      hasPanel: !!document.querySelector('.ai-tr-grid'),
      hasTrainBtn: !!el,
      hasSync: !!document.querySelector('#ai-tr-sync'),
      hasSelect: !!document.querySelector('#ai-tr-text-sel'),
      hasImageBtn: !!document.querySelector('#ai-tr-image'),
      textModels: info.text.models,
      imageActive: info.image.active,
      cloudReady: info.cloudReady,
    };
  })()`);
  check('设置页有自训练面板', panel.hasPanel === true, panel);
  check('有训练 / 同步 / 模型选择控件', panel.hasTrainBtn && panel.hasSync && panel.hasSelect && panel.hasImageBtn, panel);
  check(`未登录时云端不可用 (${panel.cloudReady})`, panel.cloudReady === false, panel);

  /* ---------- 训练不足时给提示 ---------- */
  const guard = await evalJs(`(() => {
    AITrain.clearSamples('text');
    return AITrain.trainText().then((r) => ({ ok: r.ok, message: r.message }));
  })()`);
  check('样本不足时拒绝训练并提示', guard.ok === false && /至少需要/.test(guard.message), guard);

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n===== ${okCount}/${results.length} PASS =====`);
  try {
    child.kill();
  } catch (_) {}
  process.exit(okCount === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('ERR', err.message);
  try {
    child && child.kill();
  } catch (_) {}
  process.exit(1);
});
