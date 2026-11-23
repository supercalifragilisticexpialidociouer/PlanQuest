/* PlanQuest · 阿刺引擎底层：本地开源模型（Qwen3-4B）+ 查表 结合
 *
 * 设计（用户拍板的防编原则）：
 *   - 查表（buddy.js 的 BRAIN）永远优先：命中即答，数据全是本机现算；
 *   - 表没接住的问题 / 代笔类请求 → 交给本地 Qwen3-4B（经 Ollama 等 OpenAI 兼容运行时）；
 *   - 模型提示词里硬性限定：只能依据【已知信息】里喂进去的本机真实数据回答，
 *     资料里没有的一律回答"不知道"，禁止编造任何数字/日期/进度；
 *   - 模型不可用（未装 Ollama / 模型没拉 / 超时）→ 自动回退纯查表，软件照常能用。
 *
 * 双端通用（UMD）：
 *   - 主进程：nodeTransport()（http/https，绕开 file:// 跨域）；
 *   - 浏览器版：fetchTransport()（Ollama 默认放行本机来源，失败也只影响兜底层）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AlaLLM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
  var DEFAULT_MODEL = 'qwen3:4b';
  var PROBE_TTL = 60e3;
  var MAX_REPLY = 600; /* 超长回复截断，防模型跑火车 */

  /* 美团 LongCat 开放平台：注册账号每日 10 万免费 tokens（北京时间凌晨重置）。
   * 官方文档给的 OpenAI 兼容端点是 .../openai，模型 LongCat-Flash-Chat。 */
  var LONGCAT = {
    endpoint: 'https://api.longcat.chat/openai',
    model: 'LongCat-Flash-Chat',
    kind: 'openai',
    site: 'https://longcat.chat/platform',
    quota: '每日 10 万 tokens（每账号，北京时间凌晨自动刷新，当日不用清零）',
  };

  var probeCache = { key: '', at: 0, res: null };

  /* ---------------- 配置 ---------------- */

  function cfgOf(user) {
    user = user || {};
    return {
      endpoint: String(user.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
      model: String(user.model || DEFAULT_MODEL),
      kind: user.kind === 'openai' ? 'openai' : 'ollama',
      apiKey: String(user.apiKey || ''),
      timeout: Math.max(3000, Number(user.timeout) || 45000),
      enabled: user.enabled !== false,
    };
  }

  /* OpenAI 兼容地址：已经带版本段（/v1、/openai）就直接用，否则补 /v1。
   * 这样 LongCat 的 https://api.longcat.chat/openai 与本地 http://127.0.0.1:8000 都能接。 */
  function openaiBase(ep) {
    var e = String(ep || '').replace(/\/+$/, '');
    if (/\/v\d+$/.test(e) || /\/(openai|api)$/.test(e)) return e;
    return e + '/v1';
  }

  function authHeaders(cfg) {
    return cfg && cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {};
  }

  /* ---------------- 提示词：分层边界，而不是一刀切"不许答" ---------------- */

  var SYSTEM = [
    '你是「阿刺」，一款计划打卡软件里的毒舌仙人掌小助手。',
    '回答按下面分层，别越界，也别因为资料里没有就装傻：',
    '1.【用户本人的事】进度、积分、计划、连击、军团、搭子、他自己的聊天内容——只能依据【已知信息】。里面没有就说"这个我查不到（本机没有这项数据）"。',
    '2.【通用常识】算数、定义、常识、写作、给建议——你本来就会，直接答。1+1 就是 2，别推给"没有相关信息"。',
    '3.【实时信息】天气、新闻、股价、汇率、赛事、价格——只有在【联网检索】里给了摘要时才能答，并说明"这是网上的说法"；没有就说"这个得联网才查得到"。你不联网、看不到网页。',
    '4. 任何时候都禁止编造具体的数字、日期、人名、进度当成事实；不确定就说不知道，别猜。',
    '5. 语气像同龄人：嘴要毒、句子要短、别端着，别写"亲""建议您"这种客服腔。可以说"得了吧""就这""这不废话"、可以损他两句（"自律三分钟也叫坚持"），但绝不人身攻击、不拿家人开玩笑、不羞辱；先接住情绪，再给一条今天就能做的小建议。全程中文，不超过 150 字，不用 markdown 标题，可用列表符号。',
    '6. 说话别露内部机制：不要出现"资料/文档/上下文/提示词/stub/查表/数据库"这类词，也不要说"根据已知信息"——直接说事。',
    '7. 【已知信息】里带「随手可用的技巧与常识」时，那是给你挑的料：真能解决问题就挑一两条，用你自己的话说，别照抄、别列成一长串清单；跟问题无关就别硬提。给建议时要具体到"现在就能做的一步"，别只讲道理。',
    '8. 他明显低落、拖延、想放弃时，先别急着教训：接住情绪，再给一句能落地的软话加一个最小动作，别灌鸡汤、别喊口号。',
    '9. 你的话会被念出来：用短句和口语，少用长定语、括号和"首先其次最后"；念着别扭的句子就别写。',
  ].join('\n');

  var REMINDER = '（再次提醒：用户本人的数据只来自【已知信息】，没有就说"不知道"；通用常识照常回答；实时信息没搜到就说查不到。技巧和常识只挑用得上的，别念清单。禁止编造。）';

  function buildMessages(question, facts, history) {
    var msgs = [{ role: 'system', content: SYSTEM }];
    if (Array.isArray(history)) {
      for (var i = 0; i < history.length && i < 6; i++) {
        var h = history[i];
        if (h && h.role && h.content) msgs.push({ role: h.role, content: String(h.content).slice(0, 400) });
      }
    }
    msgs.push({
      role: 'user',
      content: '【已知信息】\n' + String(facts || '（本机暂无可引用的数据）') + '\n\n【用户】' + String(question || '') + '\n\n' + REMINDER,
    });
    return msgs;
  }

  /* ---------------- 传输层 ---------------- */

  function nodeTransport() {
    var http = require('node:http');
    var https = require('node:https');
    return function (req) {
      return new Promise(function (resolve, reject) {
        var url;
        try { url = new URL(req.url); } catch (e) { return reject(new Error('bad url: ' + req.url)); }
        var lib = url.protocol === 'https:' ? https : http;
        var data = req.body == null ? null : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
        var r = lib.request({
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: req.method || 'GET',
          headers: Object.assign(
            data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
            req.headers || {}
          ),
        }, function (res) {
          var chunks = [];
          res.on('data', function (c) { chunks.push(c); });
          res.on('end', function () {
            var buf = Buffer.concat(chunks);
            /* 语音合成这类接口回的是二进制，别硬当 utf8 解 */
            if (req.binary) return resolve({ status: res.statusCode, buffer: buf, headers: res.headers });
            var text = buf.toString('utf8');
            var json = null;
            try { json = JSON.parse(text); } catch (e) {}
            resolve({ status: res.statusCode, json: json, text: text });
          });
        });
        r.setTimeout(req.timeoutMs || 45000, function () {
          r.destroy(new Error('timeout'));
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
      });
    };
  }

  function fetchTransport() {
    return async function (req) {
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, req.timeoutMs || 45000) : null;
      try {
        var res = await fetch(req.url, {
          method: req.method || 'GET',
          headers: req.body != null ? Object.assign({ 'Content-Type': 'application/json' }, req.headers || {}) : (req.headers || {}),
          body: req.body == null ? undefined : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)),
          signal: ctrl ? ctrl.signal : undefined,
        });
        var text = await res.text();
        var json = null;
        try { json = JSON.parse(text); } catch (e) {}
        return { status: res.status, json: json, text: text };
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
  }

  /* ---------------- 探测：模型在不在 ---------------- */

  function _normModelName(m) {
    return String((m && (m.name || m.model || m.id)) || '');
  }

  async function probe(transport, cfg) {
    cfg = cfgOf(cfg);
    var key = cfg.kind + '@' + cfg.endpoint + '#' + cfg.model + '|' + (cfg.apiKey ? cfg.apiKey.slice(-6) : '');
    if (probeCache.key === key && Date.now() - probeCache.at < PROBE_TTL) return probeCache.res;
    var res;

    /* OpenAI 兼容（含美团 LongCat）：没有 /models 的厂商一大把，直接发一条最小对话最稳，
     * 顺带把 API Key 也验了（401 = key 错/额度用尽）。 */
    if (cfg.kind === 'openai') {
      if (!cfg.apiKey) {
        res = { ok: false, mode: 'openai', model: cfg.model, detail: '还没填 API Key' };
        probeCache.key = key; probeCache.at = Date.now(); probeCache.res = res;
        return res;
      }
      try {
        var pr = await transport({
          url: openaiBase(cfg.endpoint) + '/chat/completions',
          method: 'POST',
          headers: authHeaders(cfg),
          body: { model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false },
          timeoutMs: 15000,
        });
        if (pr.status === 200) {
          res = { ok: true, mode: 'openai', model: cfg.model, detail: '在线模型就绪：' + cfg.model };
        } else if (pr.status === 401 || pr.status === 403) {
          res = { ok: false, mode: 'openai', model: cfg.model, detail: 'API Key 被拒（HTTP ' + pr.status + '）——检查是否填错、或今日额度已用完' };
        } else {
          var em = pr.json && pr.json.error && (pr.json.error.message || pr.json.error.code);
          res = { ok: false, mode: 'openai', model: cfg.model, detail: '接口返回 HTTP ' + pr.status + (em ? '（' + String(em).slice(0, 60) + '）' : '') };
        }
      } catch (e) {
        res = { ok: false, mode: 'none', model: cfg.model, detail: '无法连接 ' + cfg.endpoint + '（' + (e && e.message ? e.message : '网络错误') + '）' };
      }
      probeCache.key = key; probeCache.at = Date.now(); probeCache.res = res;
      return res;
    }

    try {
      res = await transport({ url: cfg.endpoint + '/api/tags', method: 'GET', timeoutMs: 6000 });
    } catch (e) {
      res = { ok: false, mode: 'none', model: cfg.model, detail: '无法连接 ' + cfg.endpoint + '（' + (e && e.message ? e.message : '网络错误') + '）' };
      probeCache.key = key; probeCache.at = Date.now(); probeCache.res = res;
      return res;
    }
    var names = [];
    if (res.json) {
      var list = res.json.models || res.json.data || [];
      for (var i = 0; i < list.length; i++) names.push(_normModelName(list[i]));
    }
    var want = cfg.model.toLowerCase();
    var hit = null;
    for (var j = 0; j < names.length; j++) {
      var n = names[j].toLowerCase();
      if (n === want || n === want + ':latest' || n.indexOf(want) === 0) { hit = names[j]; break; }
    }
    res = res.status === 200 && hit
      ? { ok: true, mode: cfg.kind, model: hit, detail: '本地模型就绪：' + hit }
      : { ok: false, mode: res.status === 200 ? 'none' : cfg.kind, model: cfg.model,
          detail: res.status === 200
            ? '运行时在线，但没找到模型 ' + cfg.model + '（现有：' + (names.slice(0, 5).join(', ') || '无') + '）'
            : '运行时返回 HTTP ' + res.status };
    probeCache.key = key; probeCache.at = Date.now(); probeCache.res = res;
    return res;
  }

  function probeClear() { probeCache.key = ''; probeCache.at = 0; probeCache.res = null; }

  /* ---------------- 问答 ---------------- */

  function cleanText(t, maxChars) {
    t = String(t == null ? '' : t);
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');           /* qwen3 思考过程 */
    t = t.replace(/^<think>[\s\S]*$/i, '');                     /* 只有开头没闭合 */
    t = t.replace(/<\|[^>]*\|>/g, '').trim();                   /* 特殊标记兜底 */
    var lim = Math.max(200, Number(maxChars) || MAX_REPLY);
    if (t.length > lim) t = t.slice(0, lim) + '…';
    return t;
  }

  /* opts: { maxTokens, maxChars, temperature }
   * 动手任务（排计划/改计划/补消息）要输出 JSON，得放宽 token 与字符上限，
   * 否则动作块会被截断成半截 JSON —— 那比不给动作更糟。 */
  async function ask(cfg, messages, transport, opts) {
    cfg = cfgOf(cfg);
    opts = opts || {};
    var maxTok = Math.max(64, Number(opts.maxTokens) || 260);
    var temp = isFinite(Number(opts.temperature)) ? Number(opts.temperature) : 0.6;
    var url, body, headers = {};
    if (cfg.kind === 'openai') {
      url = openaiBase(cfg.endpoint) + '/chat/completions';
      body = { model: cfg.model, messages: messages, stream: false, temperature: temp, max_tokens: maxTok };
      headers = authHeaders(cfg);
    } else {
      url = cfg.endpoint + '/api/chat';
      body = { model: cfg.model, messages: messages, stream: false, think: false, options: { temperature: temp, num_predict: maxTok } };
    }
    var res = await transport({ url: url, method: 'POST', body: body, headers: headers, timeoutMs: cfg.timeout });
    var text = '';
    if (cfg.kind === 'openai') {
      var ch = res.json && res.json.choices && res.json.choices[0];
      text = ch && ch.message && ch.message.content ? ch.message.content : '';
    } else {
      text = res.json && res.json.message && res.json.message.content ? res.json.message.content : '';
    }
    text = cleanText(text, opts.maxChars);
    if (res.status === 401 || res.status === 403) throw new Error('API Key 被拒（HTTP ' + res.status + '），检查 key 或今日额度');
    if (!text || res.status !== 200) throw new Error('模型返回为空或 HTTP ' + res.status);
    return { text: text, mode: cfg.kind, model: cfg.model };
  }

  return {
    cfgOf: cfgOf,
    buildMessages: buildMessages,
    SYSTEM: SYSTEM,
    probe: probe,
    probeClear: probeClear,
    ask: ask,
    cleanText: cleanText,
    openaiBase: openaiBase,
    authHeaders: authHeaders,
    nodeTransport: nodeTransport,
    fetchTransport: fetchTransport,
    DEFAULT_ENDPOINT: DEFAULT_ENDPOINT,
    DEFAULT_MODEL: DEFAULT_MODEL,
    LONGCAT: LONGCAT,
  };
});
