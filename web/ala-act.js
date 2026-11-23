/* PlanQuest · 阿刺动手层：动作协议（排计划 / 改计划 / 补消息）
 *
 * 只在「接了外接模型」时启用。职责三件事：
 *   1) 提示词 —— 把任务和输出协议一起喂给模型，协议极简，4B 小模型也写得出来；
 *   2) 解析   —— 从回复里抽出 ```json 动作块（也兜住裸 JSON 和「+ 计划名」行协议）；
 *   3) 规范化 —— 白名单过滤 + 字段清洗（时间/积分/星期/标题长度），越界的直接判废，
 *              绝不把模型随手编的东西写进用户的计划库。
 *
 * 安全边界（写在最前面，代码里也照着做）：
 *   - 模型只能"提议"，不能执行：所有动作都要用户在阿刺面板里点一下才落地；
 *   - 只能引用【已知信息】里出现过的计划 id 与搭子 uid，本模块再做一次存在性校验；
 *   - 删计划一律降级为「停用」（不删库，随时能恢复），防止模型手滑毁数据。
 *
 * 双端通用（UMD），无外部依赖。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AlaAct = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ACTS = ['plan.add', 'plan.edit', 'plan.drop', 'msg.reply'];
  var MAX_ACTS = 8;    /* 一次最多 8 个动作，防模型刷屏 */
  var MAX_PLANS = 6;   /* 一次最多排 6 条计划 */
  var MAX_TITLE = 24;
  var MAX_DESC = 60;
  var MAX_REPLY = 200;

  var BASE = [
    '你是「阿刺」，一款计划打卡软件里的毒舌仙人掌小助手。现在用户授权你帮他动手做事。',
    '硬性规则：',
    '1.【用户本人的事】进度、积分、计划名、计划 id、搭子 uid、时间、积分——一律照抄【已知信息】，不许编；已知信息里没有就直说做不到。',
    '2.【通用常识】拆计划、给建议、算时间、判断合不合理，你可以正常用常识，不要因为已知信息里没写就装傻。',
    '3.【实时信息】天气、新闻、股价、赛事这些，没有【联网检索】就别当成事实说。',
    '4. 语气毒舌但不伤人：先一句点评（不超过 40 字），紧接着给动作。不要长篇大论，不要客套。',
    '5. 全中文，不用 markdown 标题。',
  ].join('\n');

  var TASK = {
    plan: [
      '【本次任务】帮用户把要做的事排成计划。',
      '用户给你的可能是两样东西之一：',
      '· 具体几件事（"晨读 20 页、跑步 3 公里"）—— 按他说的排，别自己加戏；',
      '· 一个主题（"帮我定一个减肥计划"）—— 把主题拆成今天就能动手的 3~5 条详细计划，',
      '  每条要具体到"做什么、做多少"（如"快走 30 分钟""晚餐不吃主食"），不要"多运动""少吃饭"这种空话。',
      '每条都必须是今天能开始做的；时间排在他今天剩余的时间里，别都堆在同一分钟；积分别全给最高。',
      '【先看现实条件】已知信息里有「现实条件」这一块，排之前必须照着来：',
      '· 时间只往「现在之后」排，已经过去的时间点不要用；今天剩不了几个小时就少排两条，别硬塞。',
      '· 和「已被占用的时间」撞上就错开，别排同一分钟。',
      '· 天气不适合户外（雨、雪、台风、雾霾、高温、严寒、大风）时，不要排跑步、骑车、散步、爬山、球类这类室外活动，',
      '  换成室内等价动作（室内原地跑、室内单车、爬楼梯、室内操、室内跳绳），并在 desc 里写一句为什么换。',
      '· 用户没说天气、已知信息里也没有，就不要自己假设天气，也别在点评里编「今天天气不错」。',
    ].join('\n'),
    edit: [
      '【本次任务】评估并调整用户现有的计划。',
      '要求：只针对已知信息里真实存在的问题（时间撞车、明显超出能力、已经做不完、积分不合理），给少量、具体的调整；',
      '不新增计划（除非用户明确要），不要为了改而改——没问题就直说没问题。',
    ].join('\n'),
    msg: [
      '【本次任务】替用户起草一条要发出去的回复。',
      '要求：像本人说话，短、直、不客套、不刷屏；不编造任何数据，不替本人答应已知信息里没有的事；',
      '一条就够，不要给三个版本。',
    ].join('\n'),
  };

  var PROTOCOL = [
    '【输出格式】先写一到两句中文点评，然后另起一行输出一个 ```json 代码块：',
    '```json',
    '{"actions":[ ... ]}',
    '```',
    '动作只有这四种写法：',
    '· 排一条计划：{"act":"plan.add","title":"计划名","time":"09:00","points":20,"days":[0,1,2,3,4,5,6],"desc":"可选备注"}',
    '· 改一条计划：{"act":"plan.edit","id":"已知信息里的计划id","time":"19:00","points":30,"title":"新名（可省）"}',
    '· 停用一条计划：{"act":"plan.drop","id":"已知信息里的计划id","why":"原因"}',
    '· 补一条消息：{"act":"msg.reply","to":"已知信息里的 uid 或 #channel","text":"要发出去的话"}',
    '【字段规矩】time 必须 24 小时制 HH:MM；points 是 5~200 的整数；days 是星期数组（0=周日,1=周一…6=周六），',
    '只排今天可以省掉 days 不写；id 必须是已知信息里出现过的原样字符串，不许自己编；text 不超过 200 字。',
    '【重要】已知信息不足以完成任务时，就只写点评、不要输出 json 代码块。',
  ].join('\n');

  /* ---------------- 提示词 ---------------- */

  function buildMessages(kind, question, facts, history) {
    var k = TASK[kind] ? kind : 'plan';
    var sys = [BASE, TASK[k], PROTOCOL].join('\n\n');
    var msgs = [{ role: 'system', content: sys }];
    if (Array.isArray(history)) {
      for (var i = 0; i < history.length && i < 6; i++) {
        var h = history[i];
        if (h && h.role && h.content) msgs.push({ role: h.role, content: String(h.content).slice(0, 400) });
      }
    }
    msgs.push({
      role: 'user',
      content: '【已知信息】\n' + String(facts || '（本机暂无可引用数据）') + '\n\n【用户】' + String(question || ''),
    });
    return msgs;
  }

  /* ---------------- 解析：把动作块从回复里挖出来 ---------------- */

  function tryJson(s) {
    try {
      var o = JSON.parse(String(s || '').trim());
      return o && typeof o === 'object' ? o : null;
    } catch (e) { return null; }
  }

  /* 从 start 位置的 '{' 开始做括号配平（跳过字符串里的括号），返回对象文本 */
  function balancedAt(text, start) {
    var depth = 0, inStr = false, esc = false;
    for (var i = start; i < text.length; i++) {
      var ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return '';
  }

  function findActionObj(text) {
    var t = String(text || '');
    /* 1) 优先 fenced json，从后往前（模型常先给示例后给真正结果） */
    var fences = [];
    var re = /```[ \t]*(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/g, m;
    while ((m = re.exec(t))) fences.push({ body: m[1], raw: m[0] });
    for (var i = fences.length - 1; i >= 0; i--) {
      var o = tryJson(fences[i].body);
      if (o && Array.isArray(o.actions)) return { obj: o, raw: fences[i].raw };
    }
    /* 2) 裸 JSON：扫所有 '{'，取第一个带 actions 的 */
    for (var p = t.indexOf('{'); p >= 0; p = t.indexOf('{', p + 1)) {
      if (p > 0 && t[p - 1] === '\\') continue;
      var seg = balancedAt(t, p);
      if (!seg) continue;
      var o2 = tryJson(seg);
      if (o2 && Array.isArray(o2.actions)) return { obj: o2, raw: seg };
    }
    return null;
  }

  /* 行协议兜底：4B 模型写不出 JSON 时，认「+ 计划名 | 09:00 | 25」这种行 */
  function loosePlans(text) {
    var out = [];
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = /^\s*[+＋]\s*(.+)$/.exec(lines[i]);
      if (!m) continue;
      var parts = m[1].split(/\s*[|｜]\s*/);
      out.push({ act: 'plan.add', title: parts[0], time: parts[1], points: parts[2] });
    }
    return out;
  }

  /* 返回 { say, actions }：say 是剥掉动作块后给用户看的正文 */
  function parse(text, kind) {
    var raw = String(text == null ? '' : text);
    var found = findActionObj(raw);
    var actions = [];
    var say = raw;
    if (found) {
      actions = found.obj.actions || [];
      say = raw.replace(found.raw, '');
      /* 裸 JSON 情况：把整段（含可能的前导逗号）一并切掉 */
      say = say.replace(/```[ \t]*(?:json|JSON)?[ \t]*\r?\n?\s*```/g, '');
      if (found.obj.say && typeof found.obj.say === 'string') say = found.obj.say + '\n' + say;
    } else if (kind === 'plan') {
      var loose = loosePlans(raw);
      if (loose.length) {
        actions = loose;
        say = raw
          .split(/\r?\n/)
          .filter(function (ln) { return !/^\s*[+＋]\s*/.test(ln); })
          .join('\n');
      }
    }
    say = String(say || '')
      .replace(/^[\s,，、]+|[\s,，、]+$/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { say: say, actions: actions.slice(0, MAX_ACTS), hasBlock: !!found };
  }

  /* ---------------- 规范化 ---------------- */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function normTime(v) {
    var m = /^(\d{1,2})\s*[:：.]\s*(\d{2})$/.exec(String(v == null ? '' : v).trim());
    if (!m) return '';
    var h = Number(m[1]), min = Number(m[2]);
    if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59)) return '';
    return pad2(h) + ':' + pad2(min);
  }

  function normDays(v) {
    var arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      var n = Number(arr[i]);
      if (!isFinite(n)) continue;
      n = Math.floor(n);
      if (n === 7) n = 0;           /* 兼容"7=周日"的写法 */
      if (n < 0 || n > 6) continue;
      if (seen[n]) continue;
      seen[n] = 1;
      out.push(n);
    }
    return out.sort(function (a, b) { return a - b; });
  }

  function normPoints(v, def) {
    var n = Number(v);
    if (!isFinite(n)) n = Number(def);
    if (!isFinite(n)) n = 20;
    n = Math.round(n);
    return Math.max(5, Math.min(200, n));
  }

  function normTitle(v) {
    var t = String(v == null ? '' : v)
      .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return t.slice(0, MAX_TITLE);
  }

  function normDesc(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, MAX_DESC);
  }

  var ICON_HINT = [
    [/读|书|背|单词|英语|文献/, '📚'],
    [/跑|运动|健身|练|瑜伽|拉伸|游泳|球/, '🏃'],
    [/写|论文|作业|笔记|复盘|日记|整理/, '✍️'],
    [/睡|休息|午休|早睡/, '😴'],
    [/吃|饭|早餐|午餐|晚餐|喝水|药/, '🍚'],
    [/工作|代码|编程|开会|邮件|客户/, '💻'],
    [/打扫|洗|收拾|家务|房间/, '🧹'],
    [/走|出门|通勤|散步|买菜/, '🚶'],
    [/学|课|听|刷题|复习/, '📖'],
  ];

  function normIcon(title, given) {
    var g = String(given == null ? '' : given).trim();
    if (g && /[^\x00-\x7f]/.test(g) && g.length <= 4) return g.slice(0, 2);
    for (var i = 0; i < ICON_HINT.length; i++) if (ICON_HINT[i][0].test(title)) return ICON_HINT[i][1];
    return '🎯';
  }

  /* 把模型给的目标（id 或标题）对到真实计划上 */
  function matchPlan(raw, plans) {
    if (!Array.isArray(plans) || !plans.length) return null;
    var id = String((raw && (raw.id || raw.planId || raw.target)) || '').trim();
    if (id) {
      for (var i = 0; i < plans.length; i++) if (plans[i] && plans[i].id === id) return plans[i];
    }
    var want = normTitle((raw && (raw.title || raw.name)) || '');
    if (!want) return null;
    for (var j = 0; j < plans.length; j++) {
      var t = normTitle(plans[j] && plans[j].title);
      if (t && (t === want || t.indexOf(want) >= 0 || want.indexOf(t) >= 0)) return plans[j];
    }
    return null;
  }

  /* ctx: { plans:[{id,title}], friends:[uid], channel:bool } */
  function normOne(raw, ctx) {
    ctx = ctx || {};
    if (!raw || typeof raw !== 'object') return null;
    var act = String(raw.act || raw.type || '').trim();
    if (ACTS.indexOf(act) < 0) return null;

    if (act === 'plan.add') {
      var title = normTitle(raw.title || raw.name);
      if (!title) return null;
      var days = normDays(raw.days);
      if (!days.length) days = [1, 2, 3, 4, 5];
      return {
        act: 'plan.add',
        title: title,
        desc: normDesc(raw.desc),
        time: normTime(raw.time),
        points: normPoints(raw.points, 20),
        days: days,
        icon: normIcon(title, raw.icon),
      };
    }

    if (act === 'plan.edit' || act === 'plan.drop') {
      var hit = matchPlan(raw, ctx.plans);
      if (!hit) return null; /* 对不上任何真实计划 —— 判废，不让模型瞎改 */
      if (act === 'plan.drop') {
        return { act: 'plan.drop', id: hit.id, title: normTitle(hit.title), why: normDesc(raw.why || raw.reason) };
      }
      var patch = {};
      var nt = normTitle(raw.newTitle || raw.title);
      if (nt && nt !== normTitle(hit.title)) patch.title = nt;
      var ntm = normTime(raw.time);
      if (ntm && ntm !== String(hit.time || '')) patch.time = ntm;
      if (raw.points != null && Number(raw.points) > 0) {
        var np = normPoints(raw.points, hit.points);
        if (np !== Number(hit.points)) patch.points = np;
      }
      if (raw.desc != null) {
        var nd = normDesc(raw.desc);
        if (nd) patch.desc = nd;
      }
      if (!Object.keys(patch).length) return null; /* 啥也没改 —— 判废 */
      return { act: 'plan.edit', id: hit.id, title: normTitle(hit.title), patch: patch, why: normDesc(raw.why || raw.reason) };
    }

    /* msg.reply */
    var to = String(raw.to || raw.uid || '').trim();
    var text = String(raw.text || raw.content || '').replace(/\s+/g, ' ').trim().slice(0, MAX_REPLY);
    if (!text) return null;
    if (to === '#channel' || /^#?(channel|频道|群)$/i.test(to)) {
      if (ctx.channel === false) return null;
      return { act: 'msg.reply', to: '#channel', text: text, toName: '军团频道' };
    }
    var friends = Array.isArray(ctx.friends) ? ctx.friends : [];
    if (friends.indexOf(to) < 0) return null; /* 不是本机真实搭子 —— 判废 */
    var fname = (ctx.friendNames && ctx.friendNames[to]) || '';
    return { act: 'msg.reply', to: to, text: text, toName: fname || to };
  }

  function normAll(actions, ctx) {
    var out = [], plans = 0;
    var list = Array.isArray(actions) ? actions : [];
    for (var i = 0; i < list.length && out.length < MAX_ACTS; i++) {
      var a = normOne(list[i], ctx);
      if (!a) continue;
      if (a.act === 'plan.add') {
        plans++;
        if (plans > MAX_PLANS) continue;
      }
      out.push(a);
    }
    return out;
  }

  /* ---------------- 给界面用的文案 ---------------- */

  var WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function daysText(days) {
    if (!Array.isArray(days) || !days.length) return '每天';
    if (days.length === 7) return '每天';
    var wd = [1, 2, 3, 4, 5], we = [0, 6];
    var same = function (a, b) { return a.length === b.length && a.every(function (x, i) { return x === b[i]; }); };
    if (same(days, wd)) return '工作日';
    if (same(days, we)) return '周末';
    return days.map(function (d) { return WD[d] || ''; }).join('、');
  }

  function describe(a) {
    if (!a) return '';
    if (a.act === 'plan.add') {
      return '📌 新建「' + a.title + '」 · ' + (a.time || '待定时间') + ' · +' + a.points + ' 分 · ' + daysText(a.days);
    }
    if (a.act === 'plan.edit') {
      var bits = [];
      var p = a.patch || {};
      if (p.title) bits.push('改名「' + p.title + '」');
      if (p.time) bits.push('时间改 ' + p.time);
      if (p.points) bits.push('积分改 ' + p.points);
      if (p.desc) bits.push('备注改「' + p.desc + '」');
      return '✏️ 改「' + a.title + '」 → ' + (bits.join('、') || '无改动');
    }
    if (a.act === 'plan.drop') return '🗂️ 停用「' + a.title + '」' + (a.why ? '（' + a.why + '）' : '') + ' —— 不删除，随时能恢复';
    if (a.act === 'msg.reply') return '💬 发给「' + (a.toName || a.to) + '」：' + a.text;
    return '';
  }

  function kindOf(a) {
    if (!a) return '';
    return a.act === 'msg.reply' ? 'msg' : 'plan';
  }

  return {
    ACTS: ACTS,
    MAX_ACTS: MAX_ACTS,
    MAX_PLANS: MAX_PLANS,
    BASESYSTEM: BASE,
    PROTOCOL: PROTOCOL,
    TASK: TASK,
    buildMessages: buildMessages,
    parse: parse,
    normOne: normOne,
    normAll: normAll,
    describe: describe,
    kindOf: kindOf,
    daysText: daysText,
    /* 供测试直接调用 */
    _int: { normTime: normTime, normDays: normDays, normPoints: normPoints, normTitle: normTitle, matchPlan: matchPlan, normIcon: normIcon, findActionObj: findActionObj, loosePlans: loosePlans },
  };
});
