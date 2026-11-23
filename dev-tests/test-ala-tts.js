/* 朗读层（ala-tts.js）单测：探活、合成、出错要老实说、不能把二进制当文本 */
'use strict';
const T = require('../src/ala-tts.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

/* 假 wav：RIFF 头 + 一点噪声，够判断是不是二进制透传 */
function wavBuf() {
  return Buffer.concat([
    Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt '),
    Buffer.alloc(32, 7),
  ]);
}

(async () => {
  console.log('== 探活 ==');
  let seenUrl = '';
  const tOk = async (req) => {
    seenUrl = req.url;
    return { status: 200, json: { ok: true, model: 'MeloTTS-ZH' } };
  };
  const p1 = await T.probe(tOk, {});
  ok(p1.ok === true, '服务在 → ok');
  ok(p1.endpoint === 'http://127.0.0.1:8899', '默认地址 127.0.0.1:8899');
  ok(/\/health$/.test(seenUrl), '探的是 /health');

  const p2 = await T.probe(tOk, { endpoint: 'http://127.0.0.1:9000/' });
  ok(p2.endpoint === 'http://127.0.0.1:9000', '自定义地址去掉尾部斜杠');

  const tDown = async () => { throw new Error('ECONNREFUSED'); };
  const p3 = await T.probe(tDown, {});
  ok(p3.ok === false && /没连上/.test(p3.detail), '连不上 → ok:false 且说明原因');

  const t500 = async () => ({ status: 500, json: null });
  const p4 = await T.probe(t500, {});
  ok(p4.ok === false && /HTTP 500/.test(p4.detail), 'HTTP 500 → 明说状态码');

  console.log('== 合成 ==');
  let sent = null;
  const tTts = async (req) => {
    sent = req;
    return { status: 200, buffer: wavBuf(), headers: { 'content-type': 'audio/wav' } };
  };
  const s1 = await T.synth(tTts, '今天还有两件事没打勾', { speed: 1.2 });
  ok(s1.ok === true && s1.mime === 'audio/wav', '正常 → ok + audio/wav');
  ok(typeof s1.audio === 'string' && s1.audio.length > 0, '音频以 base64 返回');
  ok(Buffer.from(s1.audio, 'base64').slice(0, 4).toString() === 'RIFF', 'base64 解回来还是 wav');
  ok(sent.method === 'POST' && /\/tts$/.test(sent.url), '发的是 POST /tts');
  ok(sent.binary === true, '要二进制（不能被当文本截断）');
  ok(sent.body.text === '今天还有两件事没打勾' && sent.body.speed === 1.2, '文本与语速原样带上');

  const s2 = await T.synth(tTts, '   ', {});
  ok(s2.ok === false && /没有要念的内容/.test(s2.detail), '空文本 → 不发请求');

  const s3 = await T.synth(tTts, 'x'.repeat(2000), { speed: 9 });
  ok(sent.body.text.length === T.MAX_TEXT, '超长文本截到上限');
  ok(sent.body.speed === 2, '语速夹到上限 2');

  const s4 = await T.synth(tTts, 'hi', { speed: 0.1 });
  ok(sent.body.speed === 0.5, '语速夹到下限 0.5');

  console.log('== 出错要老实说 ==');
  const tErrJson = async () => ({
    status: 200, buffer: Buffer.from(JSON.stringify({ ok: false, detail: '没装 melotts' })),
    headers: { 'content-type': 'application/json' },
  });
  const e1 = await T.synth(tErrJson, '你好', {});
  ok(e1.ok === false && /没装 melotts/.test(e1.detail), '服务端报错 → 透传原因');

  const tNoAudio = async () => ({ status: 200, buffer: Buffer.alloc(0), headers: { 'content-type': 'audio/wav' } });
  const e2 = await T.synth(tNoAudio, '你好', {});
  ok(e2.ok === false && /HTTP 200/.test(e2.detail), '空音频 → 不假装成功');

  const t404 = async () => ({ status: 404, buffer: Buffer.from('nope'), headers: {} });
  const e3 = await T.synth(t404, '你好', {});
  ok(e3.ok === false && /HTTP 404/.test(e3.detail), 'HTTP 404 → 明说');

  const tThrow = async () => { throw new Error('socket hang up'); };
  const e4 = await T.synth(tThrow, '你好', {});
  ok(e4.ok === false && /朗读请求失败/.test(e4.detail), '请求失败 → 不抛出去，交回 ok:false');

  const tJsonNoOk = async () => ({ status: 200, buffer: Buffer.from('{"detail":"嗯"}'), headers: { 'content-type': 'application/json' } });
  const e5 = await T.synth(tJsonNoOk, '你好', {});
  ok(e5.ok === false, 'JSON 但没 ok → 判失败');

  /* 真 HTTP：假的 MeloTTS 服务跑在本机随机端口，走 nodeTransport 真发一次，
   * 这一步验的是"二进制没被当文本截断"——单测里 mock 掉的正是最容易出错的地方 */
  console.log('== 真 HTTP 链路（假 MeloTTS 服务）==');
  const http = require('node:http');
  const alaLlm = require('../src/ala-llm.js');
  let gotBody = null;
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, model: 'MeloTTS-ZH', speaker: 'ZH' }));
    }
    if (req.method === 'POST' && req.url === '/tts') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        gotBody = JSON.parse(b || '{}');
        const wav = wavBuf();
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', String(wav.length));
        res.end(wav);
      });
      return;
    }
    res.statusCode = 404;
    res.end('nope');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const ep = 'http://127.0.0.1:' + port;
  const tr = alaLlm.nodeTransport();

  const pr = await T.probe(tr, { endpoint: ep });
  ok(pr.ok === true, '真连 /health → ok');
  ok(pr.model === 'MeloTTS-ZH', '探活带回模型名');

  const sr = await T.synth(tr, '今天还有两件事没打勾', { endpoint: ep, speed: 1.1 });
  ok(sr.ok === true, '真 POST /tts → ok');
  ok(Buffer.from(sr.audio, 'base64').slice(0, 4).toString() === 'RIFF', '真二进制透传，base64 还能还原成 wav');
  ok(gotBody && gotBody.text === '今天还有两件事没打勾', '服务端收到的是原文');
  ok(gotBody && gotBody.speed === 1.1, '语速透传到服务端');

  const pr2 = await T.probe(tr, { endpoint: 'http://127.0.0.1:1' });
  ok(pr2.ok === false, '端口不通 → ok:false（不抛异常打断对话）');

  await new Promise((r) => srv.close(r));

  console.log('\n' + (fail ? '❌' : '✅') + '  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
