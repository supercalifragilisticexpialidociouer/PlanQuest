/* PlanQuest · 盟友「阿刺」
 * 设计原则（用户要求）：
 *  1) 角色和用户是一伙的，敌人是「那个想偷懒的自己」，系统永远不站在用户对面；
 *  2) 成功时给有温度的反馈，不是冷冰冰的「+20 分」；
 *  3) 失败时先接住情绪，再给一条今天就能做的具体建议，不做羞辱式惩罚；
 *  4) 只说本地算得出来的事，不编造「超过 80% 用户」这类没有数据支撑的话。
 * 无依赖，纯 DOM + 内联 SVG。
 */
(function () {
  'use strict';

  var STYLE_ID = 'pq-ally-style';
  var MOODS = {
    happy: { eye: '^', mouth: 'M22 44 Q34 54 46 44', brow: '' },
    idle: { eye: 'o', mouth: 'M25 46 Q34 50 43 46', brow: '' },
    worried: { eye: 'o', mouth: 'M25 50 Q34 42 43 50', brow: 'M20 30 L28 34 M48 30 L40 34' },
    fired: { eye: '>', mouth: 'M22 44 Q34 56 46 44', brow: 'M19 26 L29 30 M49 26 L39 30' },
  };

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ''
      + '#pq-ally-card{position:fixed;right:20px;bottom:20px;z-index:9998;width:340px;max-width:calc(100vw - 32px);'
      + 'display:flex;gap:12px;padding:14px;border-radius:16px;background:var(--panel,#1b2130);'
      + 'border:1px solid var(--line,#2f3a4f);box-shadow:0 18px 44px rgba(0,0,0,.34);'
      + 'font-size:13px;line-height:1.55;color:var(--text,#e7ecf5);animation:pqAllyIn .28s ease both}'
      + '@keyframes pqAllyIn{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}'
      + '#pq-ally-card.out{animation:pqAllyOut .22s ease both}'
      + '@keyframes pqAllyOut{to{transform:translateY(10px);opacity:0}}'
      + '#pq-ally-card .pqa-av{flex:0 0 52px;height:52px;border-radius:14px;display:flex;align-items:center;'
      + 'justify-content:center;background:rgba(94,234,212,.12)}'
      + '#pq-ally-card .pqa-name{font-weight:700;color:var(--mint,#5eead4);margin-right:6px}'
      + '#pq-ally-card .pqa-t{font-weight:600;margin-bottom:3px}'
      + '#pq-ally-card .pqa-b{color:var(--dim,#9aa7bd);white-space:pre-wrap}'
      + '#pq-ally-card .pqa-x{position:absolute;top:8px;right:10px;border:0;background:none;cursor:pointer;'
      + 'color:var(--dim,#9aa7bd);font-size:16px;line-height:1;padding:2px 4px}'
      + '#pq-ally-card .pqa-act{margin-top:8px}'
      + '#pq-ally-card .pqa-act button{border:1px solid var(--line,#2f3a4f);background:transparent;'
      + 'color:var(--text,#e7ecf5);border-radius:9px;padding:4px 10px;font-size:12px;cursor:pointer}'
      + '#pq-ally-card .pqa-act button:hover{border-color:var(--mint,#5eead4);color:var(--mint,#5eead4)}'
      + '.pqa-inline{display:flex;gap:10px;align-items:flex-start}'
      + '.pqa-inline .pqa-av{flex:0 0 44px;height:44px;border-radius:12px;display:flex;align-items:center;'
      + 'justify-content:center;background:rgba(94,234,212,.1)}';
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function avatar(mood, size) {
    var m = MOODS[mood] || MOODS.idle;
    var s = size || 52;
    // 仙人掌「阿刺」：圆身 + 三根刺 + 会变的眼睛
    return ''
      + '<svg width="' + s + '" height="' + s + '" viewBox="0 0 68 68" fill="none" xmlns="http://www.w3.org/2000/svg">'
      + '<rect x="14" y="50" width="40" height="7" rx="3.5" fill="#7c5a3c"/>'
      + '<path d="M34 50V22" stroke="#4ade80" stroke-width="16" stroke-linecap="round"/>'
      + '<path d="M34 36c-9 0-13-4-13-10v-3" stroke="#4ade80" stroke-width="9" stroke-linecap="round"/>'
      + '<path d="M34 40c9 0 13-4 13-10v-5" stroke="#4ade80" stroke-width="9" stroke-linecap="round"/>'
      + '<path d="M34 24v-6" stroke="#22c55e" stroke-width="4" stroke-linecap="round"/>'
      + '<path d="M26 30h-.01M42 30h-.01" stroke="#22c55e" stroke-width="4" stroke-linecap="round"/>'
      + '<circle cx="28" cy="38" r="1.6" fill="#0b1220"/>'
      + '<circle cx="40" cy="38" r="1.6" fill="#0b1220"/>'
      + '<path d="' + m.mouth + '" transform="translate(0,-2)" stroke="#0b1220" stroke-width="2" stroke-linecap="round" fill="none"/>'
      + (m.brow ? '<path d="' + m.brow + '" stroke="#0b1220" stroke-width="2" stroke-linecap="round"/>' : '')
      + '</svg>';
  }

  /* 文案池：每类多条，随机取，避免每次都是同一句 */
  var LINES = {
    praise: [
      { t: '这次真干了', b: '不是「准备干」，是干完了。这俩差着一整个人生。' },
      { t: '记上了', b: '你自己点的这一下，比任何鸡血都值钱。' },
      { t: '行啊你', b: '刚才那一下，那个想躺平的家伙没拦住你。' },
      { t: '稳', b: '不需要每天都猛，能每天都来就已经赢大半了。' },
    ],
    streak: [
      { t: '连着来了', b: '连续记录不是给别人看的，是你自己知道「我做得到」的证据。' },
      { t: '习惯在成形', b: '越往后越省力，现在这段是最贵的。' },
    ],
    complete: [
      { t: '今天全清了', b: '一天全清不容易。明天可以松一点，但别断。' },
      { t: '全勤', b: '今天的你，比昨天的你靠谱一点。' },
    ],
    warn: [
      { t: '还剩一点', b: '现在做，比睡前赶轻松一半。' },
      { t: '我提醒一下', b: '不是催你，是怕你晚上想起这事难受。' },
    ],
    fail: [
      { t: '这局算我们输', b: '不是你的问题，是这一步拆得太大了。\n明天把它砍成两半，只做前一半，做完就算过。' },
      { t: '掉了一格', b: '一次没做，不代表前面白做。\n现在花两分钟做一个最小的版本——哪怕只做 1/10。' },
      { t: '别急着自责', b: '自责特别费电，还不管用。\n把明天的量减半，先把「每天都做」这件事续上。' },
    ],
    miss: [
      { t: '时间过了', b: '窗口关了就是关了，我不帮你说好话。\n要么现在补一个最小版本，要么记下来明天优先做。' },
    ],
    chat: [
      { t: '咱俩逮到了', b: '不是「系统抓你」，是咱俩一起发现的——那个想聊天的家伙又冒头了。\n喝口水，回来接着学。' },
    ],
    privacy: [
      { t: '这些我先不说', b: '军团、战报、排行榜这类要跟别人比的东西，得先有真实的服务器数据。\n没有数据我就不会编数字，先空着。' },
    ],
  };

  function pick(kind) {
    var pool = LINES[kind] || LINES.praise;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* 顶部/行内小卡片：给「今日」页做常驻盟友条 */
  function inline(mood, title, body) {
    injectStyle();
    return ''
      + '<div class="pqa-inline">'
      + '<div class="pqa-av">' + avatar(mood, 44) + '</div>'
      + '<div style="flex:1;min-width:0">'
      + '<div class="pqa-t"><span class="pqa-name">阿刺</span>' + escapeHtml(title) + '</div>'
      + '<div class="pqa-b">' + escapeHtml(body) + '</div>'
      + '</div></div>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var current = null;
  var timer = null;

  function close() {
    if (!current) return;
    var el = current;
    current = null;
    el.classList.add('out');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  }

  /* 浮层卡片；duration=0 表示不自动关闭 */
  function card(kind, opts) {
    injectStyle();
    opts = opts || {};
    var line = { t: opts.title, b: opts.body };
    if (!line.t || !line.b) {
      var picked = pick(kind);
      line.t = line.t || picked.t;
      line.b = line.b || picked.b;
    }
    var mood = opts.mood || (kind === 'fail' || kind === 'miss' ? 'worried'
      : kind === 'chat' ? 'fired' : kind === 'warn' ? 'worried' : 'happy');
    close();
    var el = document.createElement('div');
    el.id = 'pq-ally-card';
    el.innerHTML = ''
      + '<div class="pqa-av">' + avatar(mood, 52) + '</div>'
      + '<div style="flex:1;min-width:0;padding-right:14px">'
      + '<div class="pqa-t"><span class="pqa-name">阿刺</span>' + escapeHtml(line.t) + '</div>'
      + '<div class="pqa-b">' + escapeHtml(line.b) + '</div>'
      + '<div class="pqa-act"></div>'
      + '</div>'
      + '<button class="pqa-x" aria-label="关闭">×</button>';
    document.body.appendChild(el);
    current = el;
    el.querySelector('.pqa-x').onclick = close;
    if (opts.action) {
      var btn = document.createElement('button');
      btn.textContent = opts.action.label;
      btn.onclick = function () { close(); try { opts.action.run(); } catch (e) {} };
      el.querySelector('.pqa-act').appendChild(btn);
    }
    if (opts.duration !== 0) {
      clearTimeout(timer);
      timer = setTimeout(close, opts.duration || 6400);
    }
    return el;
  }

  /* 打卡成功：把「+20 分」变成有温度的反馈，但分值仍然明确给出 */
  function praise(res) {
    res = res || {};
    var parts = [];
    if (typeof res.gained === 'number') parts.push('+' + res.gained + ' 分');
    if (res.weekendBonus) parts.push('周末双倍 +' + res.weekendBonus);
    if (res.bonus) parts.push('连续加成 +' + res.bonus);
    if (res.perfectBonus) parts.push('全勤 +' + res.perfectBonus);
    if (res.levelUp) parts.push('等级提升');
    var kind = res.perfectBonus ? 'complete' : res.streakUp ? 'streak' : 'praise';
    var p = pick(kind);
    card(kind, {
      title: p.t,
      body: p.b + (parts.length ? '\n' + parts.join(' · ') : ''),
      mood: res.perfectBonus ? 'fired' : 'happy',
    });
  }

  window.PQAlly = {
    avatar: avatar,
    inline: inline,
    card: card,
    praise: praise,
    close: close,
    lines: LINES,
  };
})();
