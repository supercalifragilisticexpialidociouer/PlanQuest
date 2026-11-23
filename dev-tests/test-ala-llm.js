/* 阿刺引擎（ala-llm.js）单测：提示词防编造、探测、解析、传输、回退 */
'use strict';
const ala = require('../src/ala-llm.js');
const http = require('node:http');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

(async () => {
  console.log('== 提示词组装（防编造硬约束）==');
  const msgs = ala.buildMessages('我今天进度咋样', '今日计划：共 3 项，已完成 1 项', []);
  ok(msgs.length === 2 && msgs[0].role === 'system', 'system+user 两条消息');
  ok(/禁止编造/.test(msgs[0].content) && /不知道/.test(msgs[0].content), 'system 含禁止编造+不知道规则');
  ok(/不联网/.test(msgs[0].content), 'system 声明不联网');
  ok(/【已知信息】/.test(msgs[1].content) && msgs[1].content.includes('已完成 1 项'), 'user 消息带资料');
  ok(/再次提醒/.test(msgs[1].content), 'user 消息尾部二次提醒');
  const msgs2 = ala.buildMessages('hi', '', []);
  ok(/暂无可引用的数据/.test(msgs2[0] === undefined ? '' : msgs2[1].content), '空资料时给占位说明');

  console.log('== 配置 ==');
  const cfg = ala.cfgOf({});
  ok(cfg.endpoint === 'http://127.0.0.1:11434', '默认 endpoint 为本机 Ollama');
  ok(cfg.model === 'qwen3:4b', '默认模型 qwen3:4b');
  ok(ala.cfgOf({ kind: 'openai', endpoint: 'http://x/' }).endpoint === 'http://x', 'openai kind + 去尾斜杠');
  ok(ala.cfgOf({ enabled: false }).enabled === false, 'enabled 可关');
  ok(ala.cfgOf({ apiKey: 'ak-123' }).apiKey === 'ak-123', 'apiKey 保留');

  console.log('== 美团 LongCat 预设 / OpenAI 地址拼接 ==');
  ok(ala.LONGCAT.endpoint === 'https://api.longcat.chat/openai', 'LongCat 官方 OpenAI 端点');
  ok(ala.LONGCAT.model === 'LongCat-Flash-Chat', 'LongCat 默认模型名');
  ok(/10 万/.test(ala.LONGCAT.quota), '预设里写明每日 10 万免费 token');
  ok(ala.openaiBase('https://api.longcat.chat/openai') === 'https://api.longcat.chat/openai', '/openai 结尾不再叠 /v1');
  ok(ala.openaiBase('http://127.0.0.1:8000') === 'http://127.0.0.1:8000/v1', '裸地址自动补 /v1');
  ok(ala.openaiBase('http://127.0.0.1:8000/v1/') === 'http://127.0.0.1:8000/v1', '已带 /v1 保持原样');
  ok(ala.authHeaders({ apiKey: 'ak' }).Authorization === 'Bearer ak', 'Bearer 鉴权头');
  ok(Object.keys(ala.authHeaders({})).length === 0, '无 key 不带鉴权头');

  console.log('== 文本清洗 ==');
  ok(!/<think>/.test(ala.cleanText('<think>推理推理</think>答案是42')), '剥离 <think> 块');
  ok(ala.cleanText('<think>没闭合的思考') === '', '未闭合 think 清空');
  ok(ala.cleanText('abcd').length <= 600, '正常文本保留');

  console.log('== 探测 ==');
  let calls = 0;
  const tOk = async () => { calls++; return { status: 200, json: { models: [{ name: 'qwen3:4b' }, { name: 'llama3:8b' }] }, text: '' }; };
  const p1 = await ala.probe(tOk, {});
  ok(p1.ok && p1.model === 'qwen3:4b', '找到 qwen3:4b');
  const p2 = await ala.probe(tOk, {});
  ok(calls === 1, '60s 内探测走缓存（不重复请求）');
  ala.probeClear();
  const tMiss = async () => ({ status: 200, json: { models: [{ name: 'llama3:8b' }] }, text: '' });
  const p3 = await ala.probe(tMiss, {});
  ok(!p3.ok && p3.mode === 'none' && /没找到模型/.test(p3.detail), '运行时在线但模型没拉 → 明说');
  ala.probeClear();
  const tDown = async () => { throw new Error('ECONNREFUSED'); };
  const p4 = await ala.probe(tDown, {});
  ok(!p4.ok && /无法连接/.test(p4.detail), '运行时不在 → 回退纯查表提示');
  ala.probeClear();
  const tPrefix = async () => ({ status: 200, json: { models: [{ name: 'qwen3:4b-instruct-q4_K_M' }] }, text: '' });
  const p5 = await ala.probe(tPrefix, {});
  ok(p5.ok, '带量化后缀的 qwen3:4b 也能匹配');

  console.log('== 美团 LongCat 探测（OpenAI 兼容）==');
  ala.probeClear();
  let lcReq = null;
  const tLc = async (req) => { lcReq = req; return { status: 200, json: { choices: [{ message: { content: 'ok' } }] }, text: '' }; };
  const pNoKey = await ala.probe(tLc, { kind: 'openai', endpoint: ala.LONGCAT.endpoint, model: ala.LONGCAT.model });
  ok(!pNoKey.ok && /API Key/.test(pNoKey.detail), '没填 Key 就明说，不白跑请求');
  ok(lcReq === null, '没 key 时根本不发请求');
  ala.probeClear();
  const pLc = await ala.probe(tLc, { kind: 'openai', endpoint: ala.LONGCAT.endpoint, model: ala.LONGCAT.model, apiKey: 'ak-test' });
  ok(pLc.ok && pLc.mode === 'openai', '带 key 探测 → 接上');
  ok(lcReq.url === 'https://api.longcat.chat/openai/chat/completions', '探测请求打到 /openai/chat/completions');
  ok(lcReq.headers && lcReq.headers.Authorization === 'Bearer ak-test', '探测带 Bearer key');
  ok(lcReq.body.max_tokens === 1, '探测只花 1 token，不浪费额度');
  ala.probeClear();
  const t401 = async () => ({ status: 401, json: { error: { message: 'invalid api key' } }, text: '' });
  const p401 = await ala.probe(t401, { kind: 'openai', endpoint: ala.LONGCAT.endpoint, model: ala.LONGCAT.model, apiKey: 'bad' });
  ok(!p401.ok && /API Key 被拒/.test(p401.detail), '401 → 提示 key 错/额度用完');
  ala.probeClear();

  console.log('== 问答解析 ==');
  const tOllama = async () => ({ status: 200, json: { message: { content: '<think>想一下</think>这个我查不到（本机没有这项数据）' } }, text: '' });
  const a1 = await ala.ask({}, ala.buildMessages('明天彩票号码', '（无）', []), tOllama);
  ok(a1.ok !== false && /查不到/.test(a1.text) && !/想一下/.test(a1.text), 'ollama 格式解析 + think 剥离');
  const tOpenai = async () => ({ status: 200, json: { choices: [{ message: { content: '今日 3 项剩 2 项' } }] }, text: '' });
  const a2 = await ala.ask({ kind: 'openai' }, msgs, tOpenai);
  ok(/剩 2 项/.test(a2.text), 'openai 兼容格式解析');
  const tEmpty = async () => ({ status: 200, json: {}, text: '' });
  let threw = false;
  try { await ala.ask({}, msgs, tEmpty); } catch (e) { threw = true; }
  ok(threw, '空回复抛错（上层回退查表）');
  const tErr = async () => ({ status: 500, json: { error: 'oops' }, text: '' });
  threw = false;
  try { await ala.ask({}, msgs, tErr); } catch (e) { threw = true; }
  ok(threw, 'HTTP 500 抛错');

  console.log('== 美团 LongCat 问答 ==');
  let askReq = null;
  const tLcAsk = async (req) => { askReq = req; return { status: 200, json: { choices: [{ message: { content: '今日 3 项，已完成 1 项。' } }] }, text: '' }; };
  const aLc = await ala.ask({ kind: 'openai', endpoint: ala.LONGCAT.endpoint, model: ala.LONGCAT.model, apiKey: 'ak-test' }, msgs, tLcAsk);
  ok(/已完成 1 项/.test(aLc.text), 'LongCat 回复解析');
  ok(askReq.url === 'https://api.longcat.chat/openai/chat/completions', '问答打到 /openai/chat/completions');
  ok(askReq.headers.Authorization === 'Bearer ak-test', '问答带 Bearer key');
  ok(askReq.body.model === ala.LONGCAT.model, '问答带模型名');
  const tLc401 = async () => ({ status: 401, json: {}, text: '' });
  threw = false;
  try { await ala.ask({ kind: 'openai', endpoint: ala.LONGCAT.endpoint, model: ala.LONGCAT.model, apiKey: 'bad' }, msgs, tLc401); } catch (e) { threw = /API Key/.test(e.message); }
  ok(threw, '401 抛 Key 相关错误（上层回退纯查表）');

  console.log('== 输出长度可调（动手任务要容得下动作 JSON）==');
  let optReq = null;
  const tOpt = async (req) => { optReq = req; return { status: 200, json: { choices: [{ message: { content: 'x'.repeat(1500) } }] }, text: '' }; };
  await ala.ask({ kind: 'openai' }, msgs, tOpt);
  ok(optReq.body.max_tokens === 260, '默认 260 token（闲聊够用）');
  const rAct = await ala.ask({ kind: 'openai' }, msgs, tOpt, { maxTokens: 900, maxChars: 2400 });
  ok(optReq.body.max_tokens === 900, '动手任务放宽到 900 token');
  ok(rAct.text.length > 600, '长回复不被 600 字砍断');
  ok(optReq.body.temperature === 0.6, '默认温度 0.6');
  await ala.ask({ kind: 'openai' }, msgs, tOpt, { temperature: 0.2 });
  ok(optReq.body.temperature === 0.2, '温度可调（动手任务压到 0.2~0.4）');
  let short = await ala.ask({ kind: 'openai' }, msgs, tOpt, { maxChars: 300 });
  ok(short.text.length === 301 && /…$/.test(short.text), 'maxChars 生效并带省略号');
  let optOllama = null;
  const tOptO = async (req) => { optOllama = req; return { status: 200, json: { message: { content: 'ok' } }, text: '' }; };
  await ala.ask({}, msgs, tOptO, { maxTokens: 700 });
  ok(optOllama.body.options.num_predict === 700, 'ollama 走 num_predict');

  console.log('== nodeTransport 真实 HTTP 链路（本地 stub）==');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: 'qwen3:4b' }] }));
      } else if (req.url === '/api/chat' && req.method === 'POST') {
        const parsed = JSON.parse(body || '{}');
        ok(parsed.messages.length === 2 && parsed.stream === false, 'stub 收到完整请求体（stream:false）');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ message: { content: '今日共 3 项，剩 2 项。少刷我，多刷题。' } }));
      } else if (req.url === '/openai/chat/completions' && req.method === 'POST') {
        const auth = req.headers.authorization || '';
        if (auth !== 'Bearer lc-key') { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'bad key' } })); return; }
        const parsed = JSON.parse(body || '{}');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'LongCat 说：今日剩 ' + (parsed.max_tokens === 1 ? '（探测）' : '2 项') } }] }));
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  ala.probeClear();
  const nt = ala.nodeTransport();
  const lp = await ala.probe(nt, { endpoint: 'http://127.0.0.1:' + port });
  ok(lp.ok && lp.model === 'qwen3:4b', 'nodeTransport 探测真实端口');
  const la = await ala.ask({ endpoint: 'http://127.0.0.1:' + port }, msgs, nt);
  ok(/剩 2 项/.test(la.text), 'nodeTransport 问答真实链路');
  ala.probeClear();
  const lcBase = 'http://127.0.0.1:' + port + '/openai';
  const lcp = await ala.probe(nt, { kind: 'openai', endpoint: lcBase, model: 'LongCat-Flash-Chat', apiKey: 'lc-key' });
  ok(lcp.ok, 'LongCat 风格路径真实 HTTP 探测通');
  const lca = await ala.ask({ kind: 'openai', endpoint: lcBase, model: 'LongCat-Flash-Chat', apiKey: 'lc-key' }, msgs, nt);
  ok(/LongCat 说/.test(lca.text), 'LongCat 真实 HTTP 问答通');
  const lcBad = await ala.probe(nt, { kind: 'openai', endpoint: lcBase, model: 'LongCat-Flash-Chat', apiKey: 'wrong' });
  ok(!lcBad.ok && /被拒/.test(lcBad.detail), '错误 key 真实链路被拒');
  server.close();

  console.log('== 超时 ==');
  const tSlow = (req) => new Promise((resolve) => setTimeout(() => resolve({ status: 200, json: { models: [] }, text: '' }), req.timeoutMs + 50));
  const t0 = Date.now();
  const p6 = await ala.probe(tSlow, {});
  ok(!p6.ok && Date.now() - t0 < 8000, '探测超时快速返回');
  ala.probeClear();

  console.log('\n结果：' + pass + ' 过，' + fail + ' 挂');
  process.exit(fail ? 1 : 0);
})();
