/* 冒烟用 stub：
 *   11434 —— 模拟 Ollama（/api/tags、/api/chat）
 *   同一端口再模拟 OpenAI 兼容厂商（LongCat 的 /openai/chat/completions），Key 校验 demo-key
 *   接了动作协议（ala-act.js）后，还要能按任务吐出 plan.add / plan.edit / plan.drop / msg.reply，
 *   否则「排计划 / 改计划 / 接消息」三条链路没法在冒烟里跑通。
 */
'use strict';
const http = require('node:http');

/* 从【资料】里抠出模型该引用的真实 id / uid —— 真模型也只看得到这些 */
function pickFacts(q) {
  return {
    ids: Array.from(q.matchAll(/\bid=([\w-]+)/g)).map((m) => m[1]),
    uids: Array.from(q.matchAll(/\buid=([\w-]+)/g)).map((m) => m[1]),
  };
}

function actReply(system, q) {
  const { ids, uids } = pickFacts(q);
  const kind = /排成计划/.test(system) ? 'plan' : /评估并调整/.test(system) ? 'edit' : /起草一条要发出去/.test(system) ? 'msg' : '';
  if (!kind) return null;
  if (kind === 'plan') {
    return '排两条，别再往上加了。\n```json\n'
      + JSON.stringify({
        actions: [
          { act: 'plan.add', title: '晨读 20 页', time: '09:00', points: 20, desc: '先读再说' },
          { act: 'plan.add', title: '拉伸 10 分钟', time: '21:00', points: 15 },
        ],
      })
      + '\n```';
  }
  if (kind === 'edit') {
    if (!ids.length) return '你今天一条计划都没有，改什么？先建两条再说。';
    const actions = [{ act: 'plan.edit', id: ids[0], time: '20:00', points: 30 }];
    if (ids[1]) actions.push({ act: 'plan.drop', id: ids[1], why: '今天做不完' });
    return '时间撞了，调一下。\n```json\n' + JSON.stringify({ actions }) + '\n```';
  }
  const to = uids[0] || '#channel';
  return '这么回就行。\n```json\n'
    + JSON.stringify({ actions: [{ act: 'msg.reply', to, text: '在打卡，晚点回你。' }] })
    + '\n```';
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    console.log('[stub]', req.method, req.url, body.slice(0, 200));
    const json = (code, obj) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(obj));
    };

    if (req.url === '/api/tags') {
      return json(200, { models: [{ name: 'qwen3:4b' }] });
    }

    /* 假搜索页：给「联网搜」链路用（解析器认 DDG 的 class 名） */
    if (req.url.indexOf('/ddg') === 0) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><body>'
        + '<a class="result__a" href="https://example.com/weather">示例气象台</a>'
        + '<a class="result__snippet" href="#">明天多云转晴，最高 18 度，早晚偏凉（stub 摘要）</a>'
        + '<a class="result__a" href="https://example.com/b">示例站点 B</a>'
        + '<a class="result__snippet" href="#">另一条摘要（stub）</a>'
        + '</body></html>');
      return;
    }

    if (req.url === '/api/chat') {
      const p = JSON.parse(body || '{}');
      const sys = (p.messages && p.messages[0] && p.messages[0].content) || '';
      const q = (p.messages && p.messages[p.messages.length - 1].content) || '';
      /* 只看用户那一句，别拿本机数据里的 "0/1" 之类误判成算式 */
      /* 只看用户那一句：尾巴上的二次提醒里带“禁止编造”，别把它当成用户在说“编” */
      const userSeg = (q.split('【用户】')[1] || q).split('（再次提醒')[0].trim();
      /* 有联网摘要就必须说清"网上说"，这正是要验的口径 */
      if (/【联网检索】/.test(q)) {
        const netSeg = (q.split('【联网检索】')[1] || '').split('【用户】')[0];
        if (/这次没搜到|没有搜到结果|连不上/.test(netSeg)) {
          return json(200, { message: { content: '（stub）这次没搜到，我不编。' } });
        }
        return json(200, { message: { content: '（stub）网上说：明天多云转晴，最高 18 度——这是网上的说法，你自己看一眼来源。' } });
      }
      const act = actReply(sys, q);
      if (act) return json(200, { message: { content: '<think>先看资料</think>' + act } });
      /* 通用常识（算数这种）本来就该直接答 */
      if (/\d+\s*[+\-*/×÷]\s*\d+|等于几|等于多少/.test(userSeg)) {
        return json(200, { message: { content: '（stub）通用常识我直接答：2。这个不用查，我算的。' } });
      }
      /* 方法类 / 通识类：真模型会直接答，stub 也得给出像样的答复，
         不然冒烟会把"模型没接住"误判成产品缺陷 */
      if (/怎么写|怎么才能|如何|为什么|是什么|啥意思|什么意思|区别|技巧|方法|建议|哪年|什么时候/.test(userSeg)) {
        return json(200, { message: { content: '（stub）这类我按常识答：先定框架再填内容——作文先列三行提纲，写完再改，别对着空白页等灵感。' } });
      }
      let reply = '（stub）这个我查不到。';
      if (/编/.test(userSeg)) reply = '（stub）没有的事我不编，这是规矩。';
      return json(200, { message: { content: '<think>冒烟思考不用出现</think>' + reply } });
    }

    /* 美团 LongCat 风格：OpenAI 兼容 + Bearer 鉴权 */
    if ((req.url === '/openai/chat/completions' || req.url === '/v1/chat/completions') && req.method === 'POST') {
      if ((req.headers.authorization || '') !== 'Bearer demo-key') {
        return json(401, { error: { message: 'invalid api key', code: 'invalid_api_key' } });
      }
      const p = JSON.parse(body || '{}');
      const probeOnly = p.max_tokens === 1;
      const q = (p.messages && p.messages[p.messages.length - 1].content) || '';
      const reply = probeOnly
        ? 'pong'
        : (/编/.test(q) ? '（LongCat stub）资料里没有的我不会编。' : '（LongCat stub）我按本机资料说：今天还剩几项，自己去看计划页。');
      return json(200, { choices: [{ message: { role: 'assistant', content: reply } }] });
    }

    json(404, {});
  });
});
server.listen(11434, '127.0.0.1', () => console.log('[stub] ollama + longcat stub on 11434'));
