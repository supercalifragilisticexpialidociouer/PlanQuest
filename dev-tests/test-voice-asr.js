/* 冒烟测试：语音转文字（Vosk 本地 ASR）→ 闲聊雷达判定
 * 用法：node dev-tests/test-voice-asr.js
 * 原理：独立 userData 启 Electron（CDP），把 asr_example_zh.wav 解码成音频，
 *      经 MediaStreamDestination 灌进 VoiceASR.attach，断言转写非空、分类器可用。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9226;
const UDATA = 'asrA-' + Date.now().toString(36);
const ROOT = path.join(__dirname, '..');
const WAV = path.join(__dirname, 'asr_example_zh.wav');
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
      const p = list.find((t) => t.type === 'page' && /index\.html/i.test(t.url)) || list.find((t) => t.type === 'page');
      if (p) return p;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('CDP 页面未找到');
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr, timeoutMs = 120000) {
  const r = await Promise.race([
    rpc('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: timeoutMs }),
    sleep(timeoutMs + 5000).then(() => ({ timeout: true })),
  ]);
  if (r.timeout) throw new Error('evaluate 超时');
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'JS 异常');
  return r.result && r.result.value;
}

async function main() {
  const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const childEnv = { ...process.env, PQ_USERDATA: UDATA };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, env: childEnv, stdio: 'ignore', detached: false,
  });
  const page = await findPage();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result || {}); pending.delete(m.id); }
  });
  await rpc('Runtime.enable', {});
  await sleep(2500); // 等页面脚本全部加载

  const href = await evaluate('window.location.href');
  console.log('page:', href);
  for (let i = 0; i < 15; i++) {
    const has = await evaluate('typeof window.VoiceASR + "/" + typeof window.AIChat');
    if (has === 'object/object') break;
    await sleep(1000);
  }
  const wavB64 = fs.readFileSync(WAV).toString('base64');
  await evaluate(`window.__WAV = '${wavB64}'`);

  const ok = await evaluate(`(async () => {
    if (!window.VoiceASR) return 'NO_VOICE_ASR';
    if (!window.AIChat) return 'NO_AICHAT';
    const bin = atob(window.__WAV);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const ctx = new AudioContext();
    const audio = await ctx.decodeAudioData(buf.buffer);
    const dest = ctx.createMediaStreamDestination();
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(dest);
    window.__asrTexts = [];
    window.__asrErr = null;
    const attached = await window.VoiceASR.attach(dest.stream, (t) => window.__asrTexts.push(t)).catch((e) => { window.__asrErr = String(e); return false; });
    if (!attached) return 'ATTACH_FAIL ' + window.__asrErr;
    src.start();
    return 'STARTED';
  })()`);

  console.log('step1 attach:', ok);
  if (ok !== 'STARTED') { throw new Error('attach 失败: ' + ok); }

  let texts = [];
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    texts = await evaluate('window.__asrTexts');
    if (texts && texts.length) break;
  }
  const label = texts.length ? await evaluate(`window.AIChat.classify(${JSON.stringify(texts[0])})`) : null;
  await evaluate('window.VoiceASR.detach()');

  const pass1 = !!texts.length;
  const pass2 = texts.length && texts[0].replace(/\s/g, '').length >= 4;
  const pass3 = !!(label && label.label);
  console.log(`${pass1 ? 'PASS' : 'FAIL'}  语音转写出文字  → ${JSON.stringify(texts[0] || '')}`);
  console.log(`${pass2 ? 'PASS' : 'FAIL'}  转写长度 >= 4 字`);
  console.log(`${pass3 ? 'PASS' : 'FAIL'}  闲聊雷达可判定  → ${JSON.stringify(label)}`);
  console.log(pass1 && pass2 && pass3 ? '\n✅ 全部通过' : '\n❌ 有失败项');
  child.kill();
  process.exit(pass1 && pass2 && pass3 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR', e.message); try { child && child.kill(); } catch (_) {} process.exit(1); });
