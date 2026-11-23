/* PlanQuest · 阿刺的朗读层（MeloTTS-ZH，主进程侧）
 *
 * 为什么需要一层：MeloTTS 官方只给 Python 库（melo.api.TTS），没有 HTTP 服务，
 * 而渲染层是 file:// 页面、也起不了 Python。所以这里定一个**极简自定协议**，
 * 由 tools/melo-tts-server.py 提供（它内部就是调官方 TTS 类）：
 *
 *   GET  /health        → 200 {"ok":true,"model":"MeloTTS-ZH"}   （探活用）
 *   POST /tts  {text,speed}  → 200 audio/wav 二进制
 *
 * 这个协议是本项目自己定的，不是 MeloTTS 的官方接口，因此不涉及"猜别人的 API"。
 * 起不来怎么办：上层自动回落到系统语音（Windows 自带中文），功能不中断。
 */
'use strict';

var DEFAULT_ENDPOINT = 'http://127.0.0.1:8899';
var MAX_TEXT = 600;

function base(ep) {
  return String(ep || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}

/* 探活：服务在不在、是不是能用的 MeloTTS */
async function probe(transport, opts) {
  opts = opts || {};
  var ep = base(opts.endpoint);
  try {
    var r = await transport({ url: ep + '/health', method: 'GET', timeoutMs: Math.max(1500, Number(opts.timeout) || 4000) });
    if (r && r.status === 200) {
      var j = r.json || {};
      return { ok: true, endpoint: ep, model: j.model || 'MeloTTS-ZH', detail: '本机朗读服务就绪' };
    }
    return { ok: false, endpoint: ep, detail: '朗读服务返回 HTTP ' + (r && r.status) };
  } catch (e) {
    return { ok: false, endpoint: ep, detail: '没连上朗读服务 ' + ep + '（' + (e && e.message ? e.message : '网络错误') + '）' };
  }
}

/* 合成：返回 { ok, mime, audio: base64 } */
async function synth(transport, text, opts) {
  opts = opts || {};
  var ep = base(opts.endpoint);
  var body = {
    text: String(text || '').slice(0, MAX_TEXT),
    speed: Math.max(0.5, Math.min(2, Number(opts.speed) || 1)),
  };
  if (!body.text.trim()) return { ok: false, detail: '没有要念的内容' };
  try {
    var r = await transport({
      url: ep + '/tts',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      binary: true,
      timeoutMs: Math.max(5000, Number(opts.timeout) || 45000),
    });
    var ct = (r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '';
    if (r.status !== 200 || !r.buffer || !r.buffer.length) {
      var hint = '';
      try { hint = r.buffer ? String(r.buffer.toString('utf8')).slice(0, 120) : ''; } catch (e) {}
      return { ok: false, detail: '朗读返回 HTTP ' + r.status + (hint ? '：' + hint : '') };
    }
    if (/json/.test(ct)) {
      /* 服务端报错也会回 200 + json，这里兜一层 */
      var j = null;
      try { j = JSON.parse(r.buffer.toString('utf8')); } catch (e) {}
      if (!j || !j.ok) return { ok: false, detail: (j && j.detail) || '朗读服务返回了错误' };
      return { ok: false, detail: '朗读服务没给音频' };
    }
    return { ok: true, mime: /wav/.test(ct) ? 'audio/wav' : (/mpeg|mp3/.test(ct) ? 'audio/mpeg' : 'audio/wav'), audio: r.buffer.toString('base64') };
  } catch (e) {
    return { ok: false, detail: '朗读请求失败（' + (e && e.message ? e.message : '网络错误') + '）' };
  }
}

module.exports = { probe: probe, synth: synth, DEFAULT_ENDPOINT: DEFAULT_ENDPOINT, MAX_TEXT: MAX_TEXT };
