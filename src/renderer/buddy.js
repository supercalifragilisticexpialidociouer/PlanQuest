/* PlanQuest · 毒舌 AI 小助手「阿刺 Pro」
 *
 * 用户要求的三件套：
 *   1) 语音识别 —— 复用 VoiceASR（Vosk 中文小模型，本地 WebAssembly，音频不出设备）；
 *   2) 查表交互 —— 回答全部来自一张写死的规则表（正则 → 毒舌语录 / 动作），
 *      不联网、不调用大模型、不编造数据；问进度/积分/军团时从本机真实数据现算；
 *   3) 3D 形象 —— 纯 CSS 3D 仙人掌：多层切片拼出体积感，可拖动旋转，
 *      会眨眼、说话时嘴巴动、被骂了会翻脸、被夸了会得意。
 *
 * 毒舌守则（与「阿刺」人设一致）：毒舌但不伤人——先接住情绪，再给一条今天就能做的建议；
 * 只说本地算得出来的事，没有数据就明说，不编百分比。
 */
(function () {
  'use strict';

  var KEY = 'pq-buddy-v1';
  var STYLE_ID = 'pq-buddy-style';

  var mem = { name: '', roasts: 0, chats: 0 };
  var getState = null;
  var navFn = null; // 打开功能：由 app.js 注入 switchView
  var open = false;
  var listening = false;
  var stream = null;
  var quiet = false; // 被要求闭嘴后的低电量模式
  var mood = 'idle';
  var moodTimer = null;
  var rotY = -18; // 当前朝向（度）
  var gl3d = null;    // 面板里的 3D 场景
  var gl3dFab = null; // 浮标里的小 3D 场景

  function loadMem() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) { var o = JSON.parse(raw); if (o && typeof o === 'object') mem = { name: '', roasts: 0, chats: 0, ...o }; }
    } catch (e) {}
  }
  function saveMem() {
    try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch (e) {}
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  /* ---------------- 样式：3D 仙人掌 ---------------- */

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ''
      /* 跟软件同一套设计令牌：面板 / 描边 / 文字 / 双主色（紫 #7c6cff · 青 #17cda8） */
      + '#pqb-fab,#pqb-panel{--pqb-panel:#ffffff;--pqb-line:rgba(20,24,60,.08);--pqb-line2:rgba(20,24,60,.16);'
      + '--pqb-text:#23263c;--pqb-dim:#9298b1;--pqb-accent:#6a5cf5;--pqb-teal:#10b894;--pqb-amber:#f59e0b;'
      + '--pqb-shadow:0 18px 50px rgba(40,44,90,.16);--pqb-chip:rgba(16,184,148,.10)}'
      + '#app[data-theme="dark"] ~ #pqb-fab,#app[data-theme="dark"] ~ #pqb-panel{--pqb-panel:#171a2e;'
      + '--pqb-line:rgba(255,255,255,.09);--pqb-line2:rgba(255,255,255,.16);--pqb-text:#f2f1ff;--pqb-dim:#9aa0cc;'
      + '--pqb-accent:#7c6cff;--pqb-teal:#17cda8;--pqb-amber:#ffb454;--pqb-shadow:0 18px 50px rgba(0,0,0,.45);'
      + '--pqb-chip:rgba(23,205,168,.14)}'
      /* 浮标：圆形头像，可在软件任意位置拖动（位置会记住） */
      + '#pqb-fab{position:fixed;left:18px;bottom:18px;z-index:9997;width:58px;height:58px;border-radius:50%;'
      + 'cursor:grab;perspective:300px;background:var(--pqb-panel);border:1px solid var(--pqb-line);'
      + 'box-shadow:var(--pqb-shadow);display:flex;align-items:center;justify-content:center;'
      + 'background-image:radial-gradient(circle at 30% 20%,var(--pqb-chip),transparent 62%);'
      + 'transition:border-color .18s,box-shadow .18s;touch-action:none;user-select:none;-webkit-user-select:none}'
      + '#pqb-fab:hover{border-color:var(--pqb-teal);box-shadow:0 22px 56px rgba(40,44,90,.22)}'
      + '#pqb-fab.dragging{cursor:grabbing;transition:none;box-shadow:0 26px 60px rgba(40,44,90,.30);border-color:var(--pqb-teal)}'
      + '#pqb-fab .pqb-badge{position:absolute;top:-2px;right:-2px;background:#ef4444;color:#fff;font-size:10px;'
      + 'border-radius:9px;padding:1px 5px;display:none;z-index:2}'
      /* 3D 舞台 */
      /* 3D 舞台：真 WebGL 画布（模型在 buddy3d.js 里现场建模） */
      + '.pqb-stage{position:relative;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;flex:0 0 auto}'
      + '.pqb-stage:active{cursor:grabbing}'
      + '.pqb-stage canvas{display:block;width:100%;height:100%;border-radius:12px}'
      + '#pqb-fab .pqb-stage canvas{border-radius:50%}'
      + '.pqb-fallback{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:30px;filter:saturate(.9)}'
      + '.pqb-stage.fab{width:58px;height:58px}'
      + '#pqb-fab .pqb-stage{width:56px;height:56px}'
      /* 面板：和软件面板同款圆角 / 描边 / 阴影 */
      + '#pqb-panel{position:fixed;left:18px;bottom:84px;z-index:9998;width:334px;max-width:calc(100vw - 32px);'
      + 'height:446px;max-height:calc(100vh - 120px);display:none;flex-direction:column;border-radius:16px;'
      + 'background:var(--pqb-panel);border:1px solid var(--pqb-line);box-shadow:var(--pqb-shadow);'
      + 'color:var(--pqb-text);font-size:13px;line-height:1.55;overflow:hidden;'
      + 'font-family:"Segoe UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif}'
      + '#pqb-panel.show{display:flex;animation:pqbIn .24s ease both}'
      + '@keyframes pqbIn{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}'
      + '#pqb-head{display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid var(--pqb-line);overflow:hidden;'
      + 'background:linear-gradient(120deg,var(--pqb-chip),transparent 70%)}'
      + '#pqb-head{min-height:104px}' + '#pqb-head .pqb-stage.head{width:96px;height:96px;margin:2px 8px 2px 2px}'
      + '#pqb-head .pqb-tt{flex:1;min-width:0}'
      + '#pqb-head .pqb-tt b{color:var(--pqb-teal)}'
      + '#pqb-head .pqb-sub{color:var(--pqb-dim);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}'
      + '#pqb-head .pqb-sub-row{display:flex;align-items:center;gap:5px;margin-top:4px}'
      + '#pqb-head .pqb-sub-row #pqb-aimode{flex:1;min-width:0}'
      + '#pqb-head .pqb-sub-row button{flex:0 0 auto}'
      + '#pqb-head button{border:0;background:none;color:var(--pqb-dim);font-size:16px;cursor:pointer;padding:2px 6px}'
      + '#pqb-clear{font-size:11px !important;border:1px solid var(--pqb-line) !important;border-radius:6px;padding:2px 7px !important}'
      + '#pqb-clear:hover{color:var(--pqb-text) !important;border-color:var(--pqb-teal) !important}'
      + '#pqb-ro{font-size:11px !important;border:1px solid var(--pqb-line) !important;border-radius:6px;padding:2px 7px !important;line-height:1.4;white-space:nowrap}'
      + '#pqb-ro:hover{color:var(--pqb-text) !important;border-color:var(--pqb-teal) !important}'
      + '#pqb-ro.on{background:#ef4444 !important;border-color:#ef4444 !important;color:#fff !important}'
      + '#pqb-ro.on:hover{color:#fff !important}'
      + '#pqb-fun{padding:6px 12px 0;font-size:10.5px;line-height:1.5;color:var(--pqb-dim)}'
      + '#pqb-fun b{color:var(--pqb-text);font-weight:600}'
      + '#pqb-msgs{flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px}'
      + '.pqb-m{max-width:82%;padding:7px 10px;border-radius:12px;white-space:pre-wrap;word-break:break-word;animation:pqbIn .18s ease both}'
      + '.pqb-m.me{align-self:flex-end;color:var(--pqb-text);background:var(--pqb-chip);border:1px solid color-mix(in srgb,var(--pqb-teal) 45%,transparent)}'
      + '.pqb-m.bud{align-self:flex-start;color:var(--pqb-text);background:color-mix(in srgb,var(--pqb-text) 8%,transparent);border:1px solid var(--pqb-line2)}'
      + '.pqb-m.sys{align-self:center;background:none;border:0;color:var(--pqb-dim);font-size:11px}'
      /* 消息外层：气泡 + 底下一排小动作（动作条在气泡外，复制/朗读都只拿正文本） */
      + '.pqb-item{position:relative;display:flex;flex-direction:column;max-width:82%;animation:pqbIn .18s ease both}'
      /* 单条删除：平时藏着，鼠标移上去才出现，不干扰读 */
      + '.pqb-del{position:absolute;top:-7px;right:-7px;width:18px;height:18px;padding:0;border-radius:50%;'
      + 'border:1px solid var(--pqb-line);background:var(--pqb-bg2);color:var(--pqb-dim);font-size:12px;'
      + 'line-height:16px;cursor:pointer;opacity:0;transition:opacity .15s;z-index:3}'
      + '.pqb-item:hover .pqb-del{opacity:1}'
      + '.pqb-del:hover{color:#ef4444;border-color:#ef4444}'
      + '.pqb-item.bud,.pqb-item.sys{align-self:flex-start}'
      + '.pqb-item.me{align-self:flex-end;align-items:flex-end}'
      + '.pqb-item .pqb-m{max-width:100%;animation:none}'
      + '.pqb-tools{display:flex;gap:3px;align-items:center;padding:3px 1px 0;opacity:.72;transition:opacity .15s}'
      + '.pqb-tools:hover,.pqb-item:hover .pqb-tools{opacity:1}'
      + '.pqb-tool{background:none;border:1px solid var(--pqb-line);border-radius:6px;cursor:pointer;'
      + 'font-size:11px;line-height:1;padding:3px 6px;color:var(--pqb-dim);transition:all .12s;font-family:inherit}'
      + '.pqb-tool:hover{border-color:var(--pqb-teal);background:var(--pqb-chip);color:var(--pqb-text)}'
      + '.pqb-rated{font-size:11px;color:var(--pqb-dim);padding:2px 2px}'
      /* 来源链接：一眼看得出能点，长标题截断，悬停给全路径 */
      + '.pqb-links{display:flex;flex-direction:column;gap:3px;max-width:100%;text-align:left}'
      + '.pqb-links-hd{font-size:11px;color:var(--pqb-dim)}'
      + '.pqb-link{font-size:11px;color:var(--pqb-teal);text-decoration:none;border-bottom:1px dotted currentColor;'
      + 'line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;cursor:pointer}'
      + '.pqb-link:hover{opacity:.8}'
      /* 点哪段念哪段：可点的段给个柔和底色，正在念的那段亮起来 */
      + '.pqb-m.readable{cursor:pointer}'
      + '.pqb-m.readable:hover,.pqb-seg:hover{background:color-mix(in srgb,var(--pqb-teal) 12%,transparent);border-radius:5px}'
      + '.pqb-seg{cursor:pointer}'
      + '.pqb-m.readable.reading,'
      + '.pqb-seg.reading{background:color-mix(in srgb,var(--pqb-teal) 22%,transparent);border-radius:5px;'
      + 'box-shadow:0 0 0 1px color-mix(in srgb,var(--pqb-teal) 45%,transparent)}'
      + '#pqb-input{display:flex;gap:6px;padding:8px 10px;border-top:1px solid var(--pqb-line)}'
      + '#pqb-input input{flex:1;min-width:0;background:color-mix(in srgb,var(--pqb-text) 6%,transparent);border:1px solid var(--pqb-line);'
      + 'border-radius:10px;color:inherit;padding:7px 10px;font-size:13px;outline:none}'
      + '#pqb-input input:focus{border-color:var(--pqb-teal)}'
      + '#pqb-input button{border:1px solid var(--pqb-line);background:transparent;color:var(--pqb-text);'
      + 'border-radius:10px;padding:0 12px;cursor:pointer;font-size:13px}'
      + '#pqb-input button:hover{border-color:var(--pqb-teal);color:var(--pqb-teal)}'
      + '#pqb-send{background:color-mix(in srgb,var(--pqb-accent) 16%,transparent) !important;border-color:color-mix(in srgb,var(--pqb-accent) 40%,transparent) !important}'
      + '#pqb-mic{font-size:15px !important}'
      + '#pqb-mic.on{border-color:#ef4444 !important;color:#ef4444 !important;animation:pqbPulse 1.1s infinite}'
      + '#pqb-speak{font-size:14px !important}'
      + '#pqb-speak.on{border-color:#22a06b !important;color:#22a06b !important}'
      + '@keyframes pqbPulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}50%{box-shadow:0 0 0 6px rgba(239,68,68,0)}}'
      /* 动作卡片：模型提议 → 勾选 → 点头才落地 */
      + '.pqb-act{align-self:stretch;border:1px solid var(--pqb-line2);border-radius:12px;padding:8px 10px;'
      + 'background:color-mix(in srgb,var(--pqb-accent) 8%,transparent);font-size:12px;animation:pqbIn .2s ease both}'
      + '.pqb-act-h{color:var(--pqb-dim);font-size:11px;margin-bottom:5px}'
      + '.pqb-act-row{display:flex;gap:6px;align-items:flex-start;padding:3px 0;cursor:pointer;line-height:1.45}'
      + '.pqb-act-row input{margin:2px 0 0;accent-color:var(--pqb-accent);flex:0 0 auto}'
      + '.pqb-act-row span{flex:1;min-width:0;word-break:break-word}'
      + '.pqb-act-foot{display:flex;gap:6px;margin-top:7px;align-items:center}'
      + '.pqb-act-foot button{border:1px solid var(--pqb-line);background:transparent;color:var(--pqb-text);'
      + 'border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer}'
      + '.pqb-act-go{background:color-mix(in srgb,var(--pqb-teal) 20%,transparent) !important;'
      + 'border-color:color-mix(in srgb,var(--pqb-teal) 45%,transparent) !important}'
      + '.pqb-act-foot button:disabled{opacity:.45;cursor:default}'
      + '.pqb-act-done{color:var(--pqb-teal);font-size:12px}'
      + '.pqb-act-tip{color:var(--pqb-dim);font-size:11px;margin-top:4px}'
      + '#pqb-hint{padding:0 12px 8px;color:var(--pqb-dim);font-size:11px}'
      /* 战友养成 / 竞技场：tab 切换 + 卡片 */
      + '#pqb-tabs{display:flex;gap:4px;padding:6px 10px 0;border-bottom:1px solid var(--pqb-line)}'
      + '#pqb-tabs button{flex:1;border:0;background:none;color:var(--pqb-dim);font-size:12px;padding:6px 2px;'
      + 'cursor:pointer;border-bottom:2px solid transparent;font-family:inherit}'
      + '#pqb-tabs button.on{color:var(--pqb-teal);border-bottom-color:var(--pqb-teal);font-weight:600}'
      + '.pqb-view{display:none;flex:1;min-height:0;flex-direction:column}'
      + '.pqb-view.on{display:flex}'
      + '#pqb-view-grow,#pqb-view-pk{overflow-y:auto;padding:10px 12px;gap:8px}'
      + '.pqb-card{border:1px solid var(--pqb-line);border-radius:10px;padding:9px 10px;'
      + 'background:color-mix(in srgb,var(--pqb-text) 4%,transparent)}'
      + '.pqb-card h4{margin:0 0 5px;font-size:12px;color:var(--pqb-teal);display:flex;justify-content:space-between;align-items:center}'
      + '.pqb-kv{display:flex;justify-content:space-between;font-size:11.5px;padding:2px 0;color:var(--pqb-dim)}'
      + '.pqb-kv b{color:var(--pqb-text);font-weight:600}'
      + '.pqb-bar{height:6px;border-radius:4px;background:var(--pqb-line);overflow:hidden;margin:4px 0}'
      + '.pqb-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--pqb-accent),var(--pqb-teal));border-radius:4px}'
      + '.pqb-btn{border:1px solid var(--pqb-line2);background:transparent;color:var(--pqb-text);border-radius:8px;'
      + 'padding:5px 9px;font-size:11.5px;cursor:pointer;font-family:inherit}'
      + '.pqb-btn:hover{border-color:var(--pqb-teal);color:var(--pqb-teal)}'
      + '.pqb-btn:disabled{opacity:.45;cursor:default}'
      + '.pqb-btn.go{background:color-mix(in srgb,var(--pqb-teal) 18%,transparent);border-color:color-mix(in srgb,var(--pqb-teal) 45%,transparent)}'
      + '.pqb-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px}'
      + '.pqb-supply{display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:4px 0;border-bottom:1px dashed var(--pqb-line)}'
      + '.pqb-supply:last-child{border-bottom:0}'
      + '.pqb-tag{font-size:10px;padding:1px 6px;border-radius:8px;background:var(--pqb-chip);color:var(--pqb-teal)}'
      + '.pqb-muted{color:var(--pqb-dim);font-size:11px}';
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------------- 3D 舞台 ----------------
   * 画布交给 buddy3d.js 现场建模渲染（参数曲面 + 光照），这里只留一个 canvas */

  function cactusDOM(scaleCls) {
    return '<div class="pqb-stage ' + (scaleCls || '') + '"><canvas class="pqb-gl"></canvas></div>';
  }

  function setMood(m, holdMs) {
    mood = m;
    if (gl3d) gl3d.setMood(m);
    clearTimeout(moodTimer);
    if (holdMs) {
      moodTimer = setTimeout(function () {
        mood = quiet ? 'sleep' : 'idle';
        if (gl3d) gl3d.setMood(mood);
      }, holdMs);
    }
  }

  var talkTimer = null;
  function talking(on) {
    if (gl3d) gl3d.setTalking(!!on);
    if (gl3dFab) gl3dFab.setTalking(!!on);
  }

  /* ---------------- 3D 互动：说一句就演一下 ----------------
   * 只有「短句 + 祈使开头」才算指令（≤14 字），
   * 免得「我今天很生气」也被当成让它演生气。
   * 文字和语音走的是同一个入口（语音最后也是变成文字喂给 answer），所以两边都认。 */
  var FUN_RULES = [
    { k: 'wiggle', re: /^(?:摇一?摇|摇摇看?|摇一下|晃一晃|晃晃)/, mood: 'smirk',
      say: ['摇完了，满意了？', '别晃，我刺要掉。', '再摇秃了算你的。', '晕了晕了，停手。', '摇一摇能摇出计划来？不能。'] },
    { k: 'jump', re: /^(?:跳一跳|跳一下|蹦一下|蹦一蹦|蹦一个|跳个舞|跳两下)/, mood: 'happy',
      say: ['蹦完了。这算你今天的运动量吗？', '落地不响，放心。', '跳是跳了，腿还是那么短。'] },
    { k: 'angry', re: /^(?:给我)?(?:生个?气|凶一个?|凶我|凶一点|发火|瞪我)/, mood: 'angry',
      say: ['行，我生气了。看好了，就这样。', '这就叫生气，学着点。'] },
    { k: 'happy', re: /^(?:给我)?(?:笑一个|笑一笑|笑个|开心一点|高兴一点|乐一个)/, mood: 'happy',
      say: ['笑成这样，够了吧？', '行行行，笑了。', '心情不错啊今天。'] },
    { k: 'surprised', re: /^(?:吃个?惊|惊讶一下|震惊一下|吓我一跳|瞪大眼|瞪眼)/, mood: 'surprised',
      say: ['吓到了？我以为你见多识广。', '啊？就这？'] },
    { k: 'sad', re: /^(?:委屈一下|委屈一个|哭一个|蔫一个|难过的表情)/, mood: 'sad',
      say: ['……行吧，这样够委屈了吗。'] },
    { k: 'sleep', re: /^(?:睡吧|睡觉|晚安|眯一?会)/, mood: 'sleep',
      say: ['行，我眯一会儿。别吵。'] },
    { k: 'left', re: /^(?:向左转|往左转|左转|转左边)/ },
    { k: 'right', re: /^(?:向右转|往右转|右转|转右边)/ },
  ];

  function funIntent(t) {
    var s = String(t || '').trim().replace(/^(?:给我|请你|你|阿刺|快|赶紧)+/, '').replace(/[\s，。、！？~～；：,.!?;:]/g, '');
    if (!s || s.length > 14) return null;
    /* 带疑问词的是在问，不是在逗它——「跳一跳怎么玩」别给我演一遍 */
    if (/怎么|如何|为什么|什么|吗|嘛/.test(s)) return null;
    for (var i = 0; i < FUN_RULES.length; i++) if (FUN_RULES[i].re.test(s)) return FUN_RULES[i];
    return null;
  }

  function funByAct(a) {
    if (a === 'left') return FUN_RULES[7];
    if (a === 'right') return FUN_RULES[8];
    if (a === 'wiggle') return FUN_RULES[0];
    if (a === 'jump') return FUN_RULES[1];
    return null;
  }

  /* 一套动作在浮标和面板两个场景里同时做，才不像两张皮 */
  function funDo(rule, opts) {
    if (!rule) return false;
    var any = false, last = null;
    [gl3d, gl3dFab].forEach(function (g) {
      if (!g) return;
      any = true;
      if (rule.k === 'left') last = g.turn(-45);
      else if (rule.k === 'right') last = g.turn(45);
      else if (rule.k === 'wiggle') g.wiggle(950);
      else if (rule.k === 'jump') g.jump(1000);
      if (rule.mood) {
        var hold = rule.k === 'sleep' ? 4200 : 2600;
        if (typeof g.moodFor === 'function') g.moodFor(rule.mood, hold);
        else g.setMood(rule.mood);
      }
    });
    if (last !== null && typeof last === 'number') rotY = last;
    if (rule.say && rule.say.length) {
      var line = rule.say[Math.floor(Math.random() * rule.say.length)];
      if (opts && opts.silent) { if (typeof toast === 'function') toast(line, '阿刺'); }
      else pushMsg('bud', line);
    }
    if (!any && typeof toast === 'function') toast('这台机器画不了 3D', '动作记住了，就是没东西可演');
    return any;
  }

  /* ---------------- 查表交互脑 ----------------
   * 规则按顺序匹配，第一条命中生效。say 可以是字符串、字符串数组（随机取一条）
   * 或函数（拿到 ctx，返回字符串）；act 用来查本机真实数据。 */

  function todayStats() {
    var s = (typeof getState === 'function' && getState()) || null;
    var plans = (s && Array.isArray(s.todayPlans)) ? s.todayPlans : [];
    var done = 0;
    for (var i = 0; i < plans.length; i++) if (plans[i] && plans[i].status === 'done') done++;
    var pts = (s && s.profile && Number(s.profile.points)) || 0;
    var streak = (s && s.profile && Number(s.profile.streak)) || 0;
    var best = (s && s.profile && Number(s.profile.bestStreak)) || 0;
    return { plans: plans, done: done, total: plans.length, left: Math.max(0, plans.length - done), pts: pts, streak: streak, best: best };
  }

  /* 打开功能：页面关键词 → 视图名 */
  var NAVS = [
    { re: /今日|主页|首页/, v: 'today', t: '今日' },
    { re: /计划/, v: 'plans', t: '计划' },
    { re: /目标|里程碑/, v: 'goals', t: '目标' },
    { re: /自习|房间|自习房/, v: 'study', t: '自习' },
    { re: /军团|PK/i, v: 'legion', t: '军团' },
    { re: /守护|强制/, v: 'guard', t: '守护' },
    { re: /统计|热力图|数据/, v: 'stats', t: '统计' },
    { re: /设置|商城|主题/, v: 'settings', t: '设置' },
  ];

  function nameOf() { return mem.name ? mem.name : '你'; }

  /* 阿刺的加油池：任务连续几轮没动时，主动推一条（毒舌但不伤人） */
  var CHEERS = [
    '还在那儿？你的计划可没在那儿等你。挑最轻的那条，先做 5 分钟。',
    '我不催你——但你的完成率催。做一条是一条，坑是从脚下填平的。',
    '连我这种植物都看得出你在拖。要不先把手机扣桌上，就扣十分钟。',
    '昨日之日不可留，今日还有几条没打。挑一个，现在。',
    '别盯着整个列表发怬，只看第一条。做完再抬头。',
    '你不是不行，你只是还没开始。去证明我这句话。',
  ];

  /* 自动填表：只填「昵称/姓名/名字/称呼/监督人」这类框，值取本机资料，不猜邮箱手机号 */
  function autofillForms() {
    var s = typeof getState === 'function' ? getState() : null;
    var val = mem.name || (s && s.profile && s.profile.name) || '';
    if (!val) return 0;
    var inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    var n = 0;
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var key = ((el.placeholder || '') + (el.name || '') + (el.id || '')).toLowerCase();
      if (!/(昵称|姓名|名字|称呼|监督人)/.test(key)) continue;
      if (el.value) continue;
      el.value = val;
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      n++;
    }
    return n;
  }

  /* ---------------- 阿刺引擎：查表 + 本地 Qwen3-4B ----------------
   * 查表永远优先；表接不住的（default / 代笔）交给本地开源模型。
   * 模型提示词硬性限定：只准依据【资料】里的本机真实数据回答，
   * 资料里没有就回答"不知道"——防编造是底线。
   * 模型不可用时自动回退纯查表，软件照常能用。 */

  var ALA_CFG_KEY = 'pq-ala-llm-v1';
  var alaReady = null;   /* {ok, model, mode} 或 {ok:false, detail} */
  var alaHist = [];      /* 近几轮对话，让模型接得上上文 */

  /* 上下文预算：早先只留 8 条（4 轮），聊半小时就忘了开头，用户骂过一次。
   * 现在给 60 条（30 轮）+ 12000 字符双闸门：聊得再久也记得住开头半小时。
   * 只走本机内存，不占服务器，代价就是一点 token。 */
  var HIST_MSGS = 60, HIST_CHARS = 12000;
  /* 只读快捷开关的回调：buildUI 里填上，外部（设置页）改完设置能顺手刷新按钮 */
  var roHook = { paint: function () {}, toggle: function () {} };
  function trimHist() {
    while (alaHist.length > HIST_MSGS) alaHist.shift();
    var sum = 0, cut = 0;
    for (var i = alaHist.length - 1; i >= 0; i--) {
      sum += String(alaHist[i].content || '').length;
      if (sum > HIST_CHARS) { cut = i + 1; break; }
    }
    if (cut > 0) alaHist = alaHist.slice(cut);
    /* 历史得从 user 开头，否则模型以为自己在自说自话 */
    while (alaHist.length && alaHist[0].role === 'assistant') alaHist.shift();
  }

  /* 引擎模式（四选）：
   *   meituan = 查表 + LongCat（美团长猫，longcat.chat 开放平台，注册每日 10 万免费 token，走官方 OpenAI 兼容接口）
   *   qwen    = 查表 + 本机 Qwen3-4B（本机 Ollama）
   *   custom  = 查表 + 自定义模型（任意 Ollama / OpenAI 兼容）
   *   table   = 纯查表（手动选定的；模型不可用时也会自动落到这里兜底） */
  var ALA_MODES = ['meituan', 'qwen', 'custom', 'table'];
  function alaMode() {
    var m = alaCfg().mode;
    return ALA_MODES.indexOf(m) >= 0 ? m : 'qwen';
  }
  function alaCfg() {
    try { var o = JSON.parse(localStorage.getItem(ALA_CFG_KEY)); if (o && typeof o === 'object') return o; } catch (e) {}
    return {};
  }
  function alaSaveCfg(c) {
    try { localStorage.setItem(ALA_CFG_KEY, JSON.stringify(c)); } catch (e) {}
  }
  function alaSetCfg(patch) {
    var c = alaCfg();
    patch = patch || {};
    for (var k in patch) if (patch[k] !== undefined) c[k] = patch[k];
    alaSaveCfg(c);
    alaHist = [];
    alaProbeNow();
    return c;
  }
  /* 本次对话实际要用的运行时配置 */
  function alaRuntimeCfg() {
    var c = alaCfg();
    var lib = window.AlaLLM;
    var LC = (lib && lib.LONGCAT) || { endpoint: 'https://api.longcat.chat/openai', model: 'LongCat-Flash-Chat' };
    var mode = alaMode();
    if (mode === 'table') return Object.assign({}, c, { mode: 'table', enabled: false });
    if (mode === 'meituan') {
      return Object.assign({}, c, {
        mode: 'meituan',
        kind: 'openai',
        endpoint: String(c.meituanEndpoint || LC.endpoint),
        model: String(c.meituanModel || LC.model),
        apiKey: String(c.meituanKey || ''),
        enabled: c.enabled !== false && !!c.meituanKey,
      });
    }
    if (mode === 'custom') {
      return Object.assign({}, c, { mode: 'custom', kind: c.kind === 'openai' ? 'openai' : 'ollama', enabled: c.enabled !== false });
    }
    return Object.assign({}, c, { mode: 'qwen', kind: 'ollama', endpoint: String(c.endpoint || 'http://127.0.0.1:11434'), model: String(c.model || 'qwen3:4b'), enabled: c.enabled !== false });
  }

  /* 本机真实资料：模型只能从这里拿事实，一块多余的都不许编。
   * 用户要求「资料扩充多一点」—— 凡本机算得出来的都喂进去，但排优先级、封顶总长度，
   * 免得把上下文撑爆反而答不准。顺序 = 重要性，超预算就从后面砍。 */
  var WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var FACTS_BUDGET = 2400;

  /* ---------------- 现实条件：天气 ----------------
   * 没有气象接口也无所谓：用户说「外面下雨」，那就是下雨。
   * 说「明天」的不影响今天；说过往的（昨天）也不管。 */
  var OUTDOOR_MAP = [
    [/跑步|慢跑/, '室内原地跑'],
    [/骑行|骑车/, '室内单车'],
    [/散步|快走/, '室内来回走'],
    [/爬山|登山|徒步/, '爬楼梯'],
    [/打球|篮球|足球|羽毛球|网球|乒乓/, '室内拉伸'],
    [/游泳/, '室内拉伸'],
    [/遛狗/, '在家陪宠物玩'],
    [/广场舞/, '室内跟练'],
    [/跳绳/, '室内跳绳'],
    [/露营|野餐|钓鱼/, '室内放松'],
  ];

  function weatherBad(text) {
    var t = String(text || '');
    if (!t) return '';
    /* 说的是明天/昨天，跟今天排计划无关 */
    if (/明天|明日|明早|明晚|昨天|昨日/.test(t) && !/今天|今日|现在|外面/.test(t)) return '';
    if (/暴雨|大雨|下雨|雨天|阵雨|雷阵雨|雨/.test(t)) return '外面下雨';
    if (/下雪|大雪|雪天|雪/.test(t)) return '外面下雪';
    if (/台风|飓风/.test(t)) return '台风天';
    if (/雾霾|沙尘|空气不好/.test(t)) return '空气不好';
    if (/高温|太热|热死|酷暑|三十[五六七八九]\s*度/.test(t)) return '外面太热';
    if (/严寒|太冷|零下|冻死/.test(t)) return '外面太冷';
    if (/大风|刮风/.test(t)) return '外面风大';
    return '';
  }

  function weatherHint(text) {
    var bad = weatherBad(text);
    if (!bad) return '';
    return '天气：' + bad + '（用户自己说的）——今天不适合户外活动。'
      + '跑步、骑车、散步、爬山、球类这些一律换成室内等价动作，并在备注里写清为什么换。';
  }

  /* 模型万一还是排了户外，本地兜一道：改标题 + 记原因，不让卡片带着「下雨去跑步」落到计划里 */
  function adjustForWeather(actions, text) {
    var bad = weatherBad(text);
    if (!bad) return actions;
    return (actions || []).map(function (a) {
      if (!a || a.act !== 'plan.add' || !a.title) return a;
      for (var i = 0; i < OUTDOOR_MAP.length; i++) {
        if (OUTDOOR_MAP[i][0].test(a.title)) {
          a.title = a.title.replace(OUTDOOR_MAP[i][0], OUTDOOR_MAP[i][1]).slice(0, 24);
          a.desc = (a.desc ? a.desc + '；' : '') + bad + '，换成室内动作';
          break;
        }
      }
      return a;
    });
  }

  function alaFacts(opts) {
    opts = opts || {};
    var s = (typeof getState === 'function' && getState()) || {};
    var t = todayStats();
    var d = new Date();
    var pr = s.profile || {};
    var secs = [];

    var base = [];
    base.push('【身份】' + (mem.name || pr.name || '未设置') + '；现在 ' + d.toLocaleString('zh-CN') + '（' + WD[d.getDay()] + '）');
    base.push('【账户】积分 ' + (pr.points || 0)
      + '；等级 Lv' + (pr.level || 1) + (pr.levelNeed ? '（' + (pr.levelCur || 0) + '/' + pr.levelNeed + '）' : '')
      + '；连击 ' + (pr.streak || 0) + ' 天（最长 ' + (pr.bestStreak || 0) + '）'
      + '；累计完成 ' + (pr.totalDone || 0) + ' 件'
      + (pr.perfectDays ? '；全勤 ' + pr.perfectDays + ' 天' : ''));
    var rate = t.total ? Math.round((t.done / t.total) * 100) : 0;
    base.push('【今天】计划 ' + t.total + ' 项，已完成 ' + t.done + '，未完成 ' + t.left + '，完成率 ' + rate + '%'
      + '；今日已得 ' + (Number(s.todayPoints) || 0) + ' 分' + (s.todayBonus ? '（含全勤奖励）' : '')
      + (Number(s.todayPomodoro) ? '；番茄钟 ' + s.todayPomodoro + ' 轮' : '')
      + (Number(s.todayFocus) ? '；专注 ' + s.todayFocus + ' 分钟' : ''));
    secs.push({ k: 'base', text: base.join('\n') });

    /* 现实条件：排计划不能只看清单，还得看现在几点、今天还剩多少时间、天气让不让出门。
     * 没有气象接口也不装——用户自己说了「外面下雨」，那就按下雨算。 */
    var real = [];
    var hourNow = d.getHours();
    var leftH = Math.max(0, 22 - hourNow);
    real.push('现在 ' + hourNow + ' 点' + (leftH > 0 ? '，今天大约还剩 ' + leftH + ' 小时可用' : '，今天基本没时间了，最多排一件小事'));
    var busy = [];
    for (var bi = 0; bi < t.plans.length && bi < 12; bi++) {
      var bp = t.plans[bi];
      if (bp && bp.time && bp.status !== 'done') busy.push(bp.time + ' ' + (bp.title || ''));
    }
    if (busy.length) real.push('已被占用的时间：' + busy.join('、') + '（新排的别撞上）');
    var wx = weatherHint(opts.text || '');
    if (wx) real.push(wx);
    secs.push({ k: 'real', text: '【现实条件】\n' + real.join('\n') });

    /* 今日计划明细（状态 + 时间 + 积分）；动作模式带上 id，模型照着引用才不会改错 */
    var today = ['【今日计划明细】' + (opts.withIds ? '（id 供改/停用引用，必须原样抄）' : '')];
    if (!t.plans.length) today.push('（今天没有计划）');
    for (var i = 0; i < t.plans.length && i < 12; i++) {
      var p = t.plans[i];
      var nm = p && (p.title || p.name);
      if (!nm) continue;
      today.push('· ' + (opts.withIds && p.id ? 'id=' + p.id + ' | ' : '')
        + (p.status === 'done' ? '✅已完成' : p.status === 'missed' ? '⚠️已错过' : '⬜未完成')
        + ' | ' + nm + ' | ' + (p.when === 'boot' ? '开机提醒' : (p.time || '—')) + ' | +' + (p.points || 0) + ' 分');
    }
    secs.push({ k: 'todayPlans', text: today.join('\n') });

    /* 随手可用的技巧与常识：按问题挑几条垫底，用户数据在先、它在后。
     * 只挑相关的几条（预算内），不整库塞给模型——塞多了它反而会照着念。 */
    if (window.AlaTips && typeof window.AlaTips.pick === 'function') {
      var tipTxt = window.AlaTips.pick(opts.text || '', { budget: opts.withIds ? 220 : 340 });
      if (tipTxt) secs.push({ k: 'tips', text: tipTxt });
    }

    /* 近 7 天 */
    var wk = Array.isArray(s.week) ? s.week : [];
    if (wk.length) {
      var seg = [], sum = 0, cnt = 0;
      for (var w = 0; w < wk.length; w++) {
        var x = wk[w] || {};
        if (!x.due) { seg.push((x.label || '') + '无计划'); continue; }
        var r7 = Math.round(((x.done || 0) / x.due) * 100);
        seg.push((x.label || '') + ' ' + (x.done || 0) + '/' + x.due);
        sum += r7; cnt++;
      }
      secs.push({ k: 'week', text: '【近 7 天】' + seg.join('、') + (cnt ? '；平均完成率 ' + Math.round(sum / cnt) + '%' : '') });
    }

    /* 近 30 天 */
    var tr = (Array.isArray(s.trend30) ? s.trend30 : []).filter(function (x) { return x && x.rate != null; });
    if (tr.length >= 3) {
      var tot = 0, best = -1, worst = 101;
      for (var j = 0; j < tr.length; j++) {
        tot += tr[j].rate;
        if (tr[j].rate > best) best = tr[j].rate;
        if (tr[j].rate < worst) worst = tr[j].rate;
      }
      secs.push({ k: 'trend', text: '【近 30 天】有记录的 ' + tr.length + ' 天，平均完成率 ' + Math.round(tot / tr.length) + '%，最高 ' + best + '%，最低 ' + worst + '%' });
    }

    /* 目标 / 里程碑 */
    var goals = Array.isArray(s.goals) ? s.goals : [];
    if (goals.length) {
      var gl = ['【目标】'];
      for (var g = 0; g < goals.length && g < 6; g++) {
        var o = goals[g] || {};
        gl.push('· ' + (o.title || '目标') + ' ' + (o.done || 0) + '/' + (o.total || 0) + ' 个里程碑（' + (o.percent || 0) + '%）');
      }
      secs.push({ k: 'goals', text: gl.join('\n') });
    }

    /* 契约项目 */
    var cps = Array.isArray(s.contractProjects) ? s.contractProjects : [];
    if (cps.length) {
      var cl = ['【对赌契约】'];
      for (var c = 0; c < cps.length && c < 5; c++) {
        var q = cps[c] || {};
        cl.push('· ' + (q.title || '契约') + ' 第 ' + (q.dayIndex || 0) + '/' + (q.days || 0) + ' 天'
          + '；今日 ' + (q.todayDone || 0) + '/' + (q.todayCount || 0)
          + '；累计应扣 ¥' + (q.oweTotal || 0) + (q.expired ? '（已到期）' : ''));
      }
      secs.push({ k: 'contracts', text: cl.join('\n') });
    }

    /* 计划库总览 */
    var all = Array.isArray(s.plans) ? s.plans : [];
    if (all.length) {
      var on = all.filter(function (x) { return x && x.enabled !== false; }).length;
      var pl = ['【计划库】共 ' + all.length + ' 条，启用 ' + on + ' 条，停用 ' + (all.length - on) + ' 条'];
      var todayIds = {};
      for (var k2 = 0; k2 < t.plans.length; k2++) if (t.plans[k2] && t.plans[k2].id) todayIds[t.plans[k2].id] = 1;
      var other = all.filter(function (x) { return x && x.enabled !== false && !todayIds[x.id]; }).slice(0, 6);
      for (var m2 = 0; m2 < other.length; m2++) {
        pl.push('· 不在今天：' + (other[m2].title || '') + ' | ' + (other[m2].when === 'boot' ? '开机提醒' : (other[m2].time || '—')));
      }
      secs.push({ k: 'plans', text: pl.join('\n') });
    }

    /* 徽章 */
    var bd = Array.isArray(s.badges) ? s.badges : [];
    if (bd.length) {
      var un = bd.filter(function (b) { return b && b.unlocked; });
      secs.push({ k: 'badges', text: '【徽章】已解锁 ' + un.length + '/' + bd.length + (un.length ? '：' + un.slice(-3).map(function (b) { return b.name; }).join('、') : '') });
    }

    /* 守护 / 惩罚档位 */
    var guardLine = [];
    try {
      var gi = s.guard || {};
      guardLine.push('强制模式 ' + (gi.enabled ? '开' : '关'));
      if (gi.blacklist) guardLine.push('黑名单 ' + (gi.blacklist.length || 0) + ' 条');
      if (gi.whitelist) guardLine.push('白名单 ' + (gi.whitelist.length || 0) + ' 条');
    } catch (e) {}
    if (s.penalty && s.penalty.label) guardLine.push('当前档位：' + s.penalty.label);
    if (guardLine.length) secs.push({ k: 'guard', text: '【守护】' + guardLine.join('；') });

    /* 社交：搭子 / 军团 */
    var soc = [];
    var fr = friendsNow();
    if (fr && fr.friends) {
      var fu = Object.keys(fr.friends);
      soc.push('搭子 ' + fu.length + ' 人' + (fr.rates && fr.rates.my != null ? '，我今日完成率 ' + fr.rates.my + '%' : ''));
    }
    try {
      if (window.PQLegion && PQLegion.info && PQLegion.info().joined) {
        var inf = PQLegion.info();
        soc.push('军团已加入（码 ' + (inf.code || '') + '）'
          + (inf.agg && inf.agg.n ? '，' + inf.agg.n + ' 人，今日 ' + inf.agg.today.checked + ' 人已打卡' : ''));
      } else {
        soc.push('军团未加入');
      }
    } catch (e) {}
    if (soc.length) secs.push({ k: 'social', text: '【社交】' + soc.join('；') });

    /* 欠分时的微阶梯 */
    if (s.micro && s.micro.active) {
      secs.push({ k: 'micro', text: '【回分阶梯】现在欠 ' + Math.abs(s.micro.points || 0) + ' 分，每完成一条回 ' + (s.micro.gain || 0) + ' 分；今日阶梯 ' + (s.micro.done || 0) + '/' + (s.micro.total || 0) });
    }

    /* 按优先级拼装，超预算就停 */
    var out = [], len = 0;
    for (var i2 = 0; i2 < secs.length; i2++) {
      var sg = secs[i2];
      if (!sg || !sg.text) continue;
      if (out.length && len + sg.text.length > FACTS_BUDGET) break;
      out.push(sg.text);
      len += sg.text.length + 1;
    }
    return out.join('\n');
  }

  function alaLLMAsk(text, extraFacts, opts) {
    var lib = window.AlaLLM;
    if (!lib) return Promise.resolve(null);
    var cfg = alaRuntimeCfg();
    if (cfg.enabled === false) return Promise.resolve(null);
    if (cfg.mode === 'custom' && !cfg.endpoint) return Promise.resolve(null);
    if (cfg.mode === 'meituan' && !cfg.apiKey) return Promise.resolve(null);
    var facts = alaFacts({ text: text }) + (extraFacts ? '\n\n' + extraFacts : '');
    var msgs = lib.buildMessages(text, facts, alaHist);
    return new Promise(function (resolve) {
      function done(r) {
        var txt = r && r.ok && r.text ? r.text : (r && r.text ? r.text : null);
        if (txt && !(opts && opts.noHist)) {
          alaHist.push({ role: 'user', content: String(text).slice(0, 800) });
          alaHist.push({ role: 'assistant', content: String(txt).slice(0, 600) });
          trimHist();
        }
        resolve(txt);
      }
      if (window.api && typeof window.api.alaAsk === 'function') {
        window.api.alaAsk({ cfg: cfg, messages: msgs }).then(done, function () { resolve(null); });
      } else {
        lib.ask(cfg, msgs, lib.fetchTransport()).then(function (r) { done(r); }, function () { resolve(null); });
      }
    });
  }

  function alaReadyLine() {
    if (alaMode() === 'table') return '引擎：极速模式（设置页手动选定），只答本机数据，不联网。';
    return alaReady && alaReady.ok
      ? '引擎：' + alaReady.model + ' 已就绪，复杂些的问题也能聊——只说本机数据，答不了会直说不知道。'
      : '引擎：极速模式（' + ((alaReady && alaReady.detail) || '模型暂未就绪') + '）。';
  }

  function alaModeLabel() {
    var m = alaMode();
    if (m === 'table') return '⚡ 极速';
    if (alaReady && alaReady.ok) return '🧠 ' + alaReady.model;
    return '⚡ 未接模型';
  }

  function updateAlaUI() {
    var el = document.getElementById('pqb-aimode');
    if (el) {
      el.textContent = alaModeLabel();
      el.title = alaReadyLine();
    }
    var hint = document.getElementById('pqb-hint');
    if (hint) {
      if (alaMode() === 'table') {
        hint.textContent = '极速模式：只答本机数据，不联网，答不了就直说不知道。去设置页可接美团 / Qwen3-4B / 自定义模型。';
      } else if (alaReady && alaReady.ok) {
        var can = [];
        if (capOn('plan')) can.push('排计划');
        if (capOn('edit')) can.push('改计划');
        if (capOn('msg')) can.push('接消息');
        hint.textContent = '本机数据秒回；' + alaReady.model + ' 接着答'
          + (can.length ? '，还能帮你' + can.join(' / ') + '——提议都得你点头才动手。' : '。')
          + '只说本机数据，答不了直说不知道。';
      } else {
        hint.textContent = '模型没接上 → 极速模式（只答本机数据）。设置页可接 LongCat（美团长猫，longcat.chat，每日 10 万免费 token）/ 本机 Qwen3-4B / 自定义模型。';
      }
    }
  }

  function alaProbeNow() {
    var lib = window.AlaLLM;
    if (!lib) return;
    var mode = alaMode();
    if (mode === 'table') {
      alaReady = { ok: false, detail: '当前为极速模式' };
      updateAlaUI();
      return;
    }
    var cfg = alaRuntimeCfg();
    if (cfg.enabled === false) {
      if (mode === 'meituan' && !cfg.apiKey) {
        alaReady = { ok: false, detail: '还没填 LongCat API Key（美团长猫，longcat.chat 注册后自动有 default key）' };
      } else if (mode === 'custom' && !cfg.endpoint) {
        alaReady = { ok: false, detail: '自定义模型还没填接口地址（设置页里填）' };
      } else {
        alaReady = { ok: false, detail: '模型已临时关闭（说「开启模型」接回）' };
      }
      updateAlaUI();
      return;
    }
    var p = (window.api && typeof window.api.alaProbe === 'function')
      ? Promise.resolve(window.api.alaProbe(cfg))
      : lib.probe(lib.fetchTransport(), cfg);
    Promise.resolve(p).then(function (r) {
      alaReady = r && r.ok
        ? { ok: true, model: r.model, mode: r.mode, engine: mode }
        : { ok: false, detail: (r && r.detail) || '未检测到模型' };
      updateAlaUI();
    }).catch(function () {
      alaReady = { ok: false, detail: '模型探测失败' };
      updateAlaUI();
    });
  }

  /* ---------------- 联网搜（默认关，用户手动打开才用） ----------------
   * 打开后：先搜再把摘要喂给模型，回答里必须说清"这是网上的说法"，
   * 并且把参考链接原样贴出来让用户自己核。搜不到就说搜不到，不拿旧知识冒充。 */

  var ALA_NET_KEY = 'pq-ala-net-v1';

  function alaNetCfg() {
    try {
      var o = JSON.parse(localStorage.getItem(ALA_NET_KEY));
      if (o && typeof o === 'object') return { on: !!o.on, endpoint: String(o.endpoint || '') };
    } catch (e) {}
    return { on: false, endpoint: '' };
  }
  function alaSetNet(patch) {
    var c = alaNetCfg();
    patch = patch || {};
    if (typeof patch.on === 'boolean') c.on = patch.on;
    if (patch.endpoint !== undefined) c.endpoint = String(patch.endpoint || '');
    try { localStorage.setItem(ALA_NET_KEY, JSON.stringify(c)); } catch (e) {}
    return c;
  }
  function netOn() { return alaNetCfg().on; }

  function alaNetSearch(q) {
    var cfg = alaNetCfg();
    if (!cfg.on) return Promise.resolve(null);
    var api = window.api;
    var query = String(q || '').replace(/^(阿刺|喂|那个|帮我|请|你)/, '').trim().slice(0, 80);
    if (!query) return Promise.resolve(null);
    if (!api || typeof api.alaWeb !== 'function') return Promise.resolve({ ok: false, detail: '这台设备不支持联网搜' });
    return Promise.resolve(api.alaWeb({ q: query, endpoint: cfg.endpoint }))
      .then(function (r) { return r || { ok: false, detail: '搜不到' }; },
        function () { return { ok: false, detail: '联网搜索没连上' }; });
  }

  function netFacts(r) {
    if (!r) return '';
    if (!r.ok) {
      return '【联网检索】这次没搜到（' + (r.detail || '网络不通') + '）。'
        + '通用常识照常回答；实时信息（天气/新闻/股价等）就说"这个得联网才查得到"，不要拿旧记忆当事实。';
    }
    var list = (r.results || []).slice(0, 4);
    if (!list.length) {
      return '【联网检索】没有搜到结果。通用常识照常回答；实时信息就说查不到，不要编。';
    }
    var lines = ['【联网检索】刚搜到的网页摘要（引用时必须说"网上说"，不许当成本机数据）：'];
    for (var i = 0; i < list.length; i++) {
      lines.push((i + 1) + '. ' + list[i].title + ' — ' + (list[i].snippet || '（无摘要）') + '（' + list[i].url + '）');
    }
    return lines.join('\n');
  }

  /* 本条问题值不值得联网搜：本机话题、纯算数、纯闲聊都不搜 —— 省时间也省 token */
  function netWorth(text) {
    var t = String(text || '').trim();
    if (t.length < 2) return false;
    if (/^(嗯|哦|啊|哈|你好|在吗|谢谢|哈哈+)[！!。.~]*$/.test(t)) return false;
    if (/进度|积分|分数|连击|打卡|计划|任务|军团|搭子|自习|专注|番茄|徽章|等级|目标|契约|守护/.test(t)) return false;
    if (/闭嘴|安静|醒醒|你是谁|骂|笨|蠢|笑话/.test(t)) return false;
    /* 方法论 / 通用知识（怎么写、为什么、是什么、有什么技巧）不是实时信息，
     * 搜出来也是一堆广告和标题党，还给答案添了无用的"参考"尾巴 */
    if (/怎么写|咋写|如何(写|做|选|学|提高|安排|坚持|开始|面对)|怎么办|怎么才能|怎样才能|为什么|是什么|啥意思|什么意思|有什么区别|区别在哪|该不该|值不值|要不要|推荐|入门|技巧|方法|建议|怎么学|记不住|学不会|没动力|怎么坚持/.test(t)) return false;
    /* 纯算数、纯符号：模型自己就会，别去搜 */
    if (/^[\d\s+\-*/×÷()（）=？?.]+$/.test(t)) return false;
    if (/^\d+\s*[\+\-*/×÷]\s*\d+/.test(t)) return false;
    if (/等于几|等于多少|几加几|算一下|计算结果/.test(t) && /[\d+\-*/×÷]/.test(t)) return false;
    return true;
  }

  /* 把某一轮从上下文里撤掉：模型先说了"答不了"、随后又查到了正确答案时用，
   * 免得后面几轮它还惦记着自己刚才那句"不知道"。 */
  function dropHist(text) {
    var t = String(text || '');
    for (var i = alaHist.length - 1; i >= 0; i--) {
      if (alaHist[i] && alaHist[i].role === 'user' && alaHist[i].content === t) {
        alaHist.splice(i, i + 1 < alaHist.length ? 2 : 1);
        return;
      }
    }
  }

  /* 回答顺序是刻意的：① 先用自己的知识答 → ② 答不上来翻常识库 → ③ 还不行才联网。
   * 上来就搜既慢又容易被标题党带偏；一句话就推"查不到"又太糊弄——
   * 连"你有病吧"这种话都得先正常回一句，而不是甩个不知道给用户。 */
  function dontKnow(txt) {
    var t = String(txt || '').trim();
    if (!t) return true;
    if (t.replace(/[\s，。、！？；：,.!?;:`~'"（）()]/g, '').length <= 2) return true;
    return /查不到|不知道|不清楚|没有(这|该|相关)?(项|方面)?(数据|信息|内容)|无法回答|回答不了|答不上/.test(t) && t.length < 100;
  }

  function alaReply(text, rule, m, ctx) {
    setMood('listen', 0);
    var tips = '';
    try { if (window.AlaTips && window.AlaTips.pick) tips = window.AlaTips.pick(text, { budget: 260 }); } catch (e) {}
    var allowNet = netOn() && netWorth(text);

    function show(txt, web) {
      setMood(rule.mood || 'happy', 5200);
      talking(true);
      setTimeout(function () {
        talking(false);
        pushMsg('bud', txt, { q: text });
        if (web && web.ok && web.results && web.results.length) pushLinks(web);
      }, 300);
    }
    function plainFallback() {
      var out = tableOut(rule, m, ctx);
      setMood(rule.mood || 'idle', 5200);
      pushMsg('bud', out, { q: text });
    }
    /* 常识库兜底只给"确实在问知识/方法"的问题：
     * 骂人、闲扯、情绪话不该被塞一堆"空调 26℃"，那比答不上来还难看。 */
    function looksLikeHow(q) {
      return /怎么|如何|为什么|是什么|啥意思|什么意思|区别|该不该|要不要|能不能|有没有|哪年|什么时候|技巧|方法|建议|怎么学|怎么办/.test(String(q || ''));
    }
    function tipsAnswer() {
      if (!tips || !looksLikeHow(text)) return '';
      var body = tips.replace(/^【[^】]*】[^\n]*\n?/, '').replace(/^· \[[^\]]+\] /gm, '· ');
      if (!body) return '';
      return pick(['这个我脑子里没有现成的，但手边有几条能用的：', '不装懂，先给你几条能立刻试的：']) + '\n' + body;
    }

    /* 实时类问题、但联网没开：别装懂也别只说"查不到"，直接告诉他开关在哪 */
    var live = /天气|气温|下雨|新闻|股价|汇率|油价|票价|金价|航班|比分|赛程|上映|发布会|多少钱|价格|报价/.test(text);
    if (live && !allowNet) {
      show('这个得联网才查得到——设置页把「联网搜」打开，我立马去查一眼。\n本机没有的东西我不猜。', null);
      return;
    }

    /* 第一步：它会的东西直接答——能答就不提"查"字 */
    alaLLMAsk(text, tips).then(function (first) {
      if (first && !dontKnow(first)) { show(first, null); return null; }
      if (first) dropHist(text);          /* 这句"答不了"不留在上下文里 */
      if (!allowNet) {
        var ta = tipsAnswer();
        if (ta) { show(ta, null); return null; }
        /* 知识 / 方法类：就算模型只说了句"不知道"也照给，那是诚实回答 */
        if (first && looksLikeHow(text)) { show(first, null); return null; }
        /* 其余的（骂人、闲扯、情绪）交给查表：毒舌回嘴比一句"看不懂"体面 */
        plainFallback();
        return null;
      }
      /* 第二步：真答不了才联网，带着摘要再问一次 */
      pushMsg('sys', '这个我脑子里没有，去网上看一眼…');
      return alaNetSearch(text).then(function (web) {
        var extra = netFacts(web) + (tips ? '\n\n' + tips : '');
        return alaLLMAsk(text, extra, { noHist: true }).then(function (t2) {
          if (t2 && !dontKnow(t2)) { show(t2, web); return; }
          if (t2) { show(t2, web); return; }
          /* 没模型也能给点东西：把摘要摆出来让他自己看，链接在下面 */
          if (web && web.ok && web.results && web.results.length) {
            var head = '我没法把这几条揉成一句人话，但确实搜到了，你自己扫一眼：';
            var body = web.results.slice(0, 2).map(function (x) {
              return '· ' + x.title + '：' + String(x.snippet || '').slice(0, 60);
            }).join('\n');
            show(head + '\n' + body, web);
            return;
          }
          var ta2 = tipsAnswer();
          if (ta2) { show(ta2, null); return; }
          plainFallback();
        });
      });
    });
  }

  /* ---------------- 朗读（MeloTTS-ZH 优先，系统语音兜底） ----------------
   * 为什么要有兜底：MeloTTS 是本地 Python 服务，没装/没起/端口被占都正常。
   * 所以顺序是：先问本地服务 → 有音频就放 → 没有就交给系统中文语音，
   * 两样都不行就安静待着（不弹错、不打断对话）。
   *
   * 只在「阿刺自己说的话」上朗读：预告、回执、系统提示一律不念，省得吵。 */

  var ALA_TTS_KEY = 'pq-ala-tts-v1';
  var ttsAudio = null;      /* 当前在放的那个 Audio，切新句子要先掐掉 */
  var ttsProbed = null;     /* 本地服务探活结果缓存，避免每句都去连一次 */
  var ttsProbedAt = 0;
  var ttsSpeaking = false;

  function alaTtsCfg() {
    var d = { on: false, endpoint: '', speed: 1 };
    try {
      var o = JSON.parse(localStorage.getItem(ALA_TTS_KEY));
      if (o && typeof o === 'object') {
        d.on = !!o.on;
        d.endpoint = String(o.endpoint || '');
        var sp = Number(o.speed);
        if (sp >= 0.5 && sp <= 2) d.speed = sp;
      }
    } catch (e) {}
    return d;
  }
  function alaSetTts(patch) {
    var c = alaTtsCfg();
    patch = patch || {};
    if (typeof patch.on === 'boolean') c.on = patch.on;
    if (patch.endpoint !== undefined) c.endpoint = String(patch.endpoint || '');
    if (patch.speed !== undefined) {
      var sp = Number(patch.speed);
      if (sp >= 0.5 && sp <= 2) c.speed = sp;
    }
    try { localStorage.setItem(ALA_TTS_KEY, JSON.stringify(c)); } catch (e) {}
    if (!c.on) stopSpeak();
    updateTtsUI();
    return c;
  }

  /* 念得出口的文本：去表情、去 markdown 符号、去链接，太长只念开头 */
  function speakable(text) {
    var t = String(text || '');
    t = t.replace(/参考（[^）]*）[\s\S]*$/, '');          /* 尾巴上的来源清单不念 */
    t = t.replace(/https?:\/\/\S+/g, '');
    t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
    t = t.replace(/[*_`#>|~]/g, '').replace(/[·•]/g, '，');
    t = t.replace(/\s*\n+\s*/g, '。').replace(/。{2,}/g, '。');
    t = t.replace(/[（(][^）)]{0,20}[）)]/g, '');          /* 括注念出来很怪 */
    /* 念出来要"嘴快、年轻"：长破折号变逗号，省略号变句号，长句在逗号处断开。
     * 一口气念二十多个字会显得又老又困，断成短句就有节奏了。 */
    t = t.replace(/[—–]{1,}/g, '，').replace(/\.{3,}|…+/g, '。');
    t = t.replace(/([^，。！？；：]{16,})[，,]/g, '$1。');
    t = t.replace(/\s{2,}/g, ' ').trim();
    if (t.length > 180) t = t.slice(0, 180).replace(/[，、。；：]$/, '') + '…';
    return t;
  }

  /* 正在念的那一段：给它加个高亮，念完/停掉就摘掉，用户能看到"现在念的是这句" */
  var speakEl = null;
  function markSpeak(el) {
    if (speakEl && speakEl !== el && speakEl.classList) speakEl.classList.remove('reading');
    speakEl = el || null;
    if (speakEl && speakEl.classList) speakEl.classList.add('reading');
  }

  /* 点哪段念哪段：再点同一段就是停 */
  function speakSeg(text, el) {
    if (speakEl === el && ttsSpeaking) { stopSpeak(); return; }
    if (listening) {
      pushMsg('sys', '先把麦克风关了我再念——不然我自己念的话会被自己听进去。');
      return;
    }
    stopSpeak();
    speak(text, { force: true, el: el }).then(function (r) {
      if (!r || !r.ok) markSpeak(null);
    });
  }

  function stopSpeak() {
    if (ttsAudio) {
      try { ttsAudio.pause(); } catch (e) {}
      ttsAudio = null;
    }
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (e) {}
    ttsSpeaking = false;
    clearTimeout(talkTimer);
    talking(false);
    markSpeak(null);
  }

  /* 系统语音兜底：Windows/macOS/安卓都自带中文音色 */
  function speakSystem(txt, speed) {
    try {
      var syn = window.speechSynthesis;
      if (!syn || typeof SpeechSynthesisUtterance !== 'function') return false;
      var u = new SpeechSynthesisUtterance(txt);
      u.lang = 'zh-CN';
      /* 系统语音偏慢偏沉，听着像播报：比设定快 6%、音高高一点，才像同龄人在说话 */
      u.rate = Math.max(0.5, Math.min(2, (Number(speed) || 1) * 1.06));
      u.pitch = 1.12;
      u.onend = function () { ttsSpeaking = false; clearTimeout(talkTimer); talking(false); markSpeak(null); };
      /* 报错不立刻闭嘴：不少环境没有中文语音包，speak() 会秒 error，
       * 嘴刚张开就合上，看着像「根本没动」。交给 speak() 里按字数估的时长兜底。 */
      u.onerror = function () { ttsSpeaking = false; markSpeak(null); };
      ttsSpeaking = true;
      talking(true);   /* 嘴跟着声音动 */
      syn.speak(u);
      return true;
    } catch (e) { return false; }
  }

  /* 探活：通了就记住 5 分钟；没通只记 20 秒——
   * 用户边看说明书边起服务，别让他干等五分钟才听到声音。 */
  var TTS_OK_TTL = 5 * 60e3;
  var TTS_BAD_TTL = 20e3;

  function probeTts() {
    var api = window.api;
    var cfg = alaTtsCfg();
    if (!api || typeof api.alaTtsProbe !== 'function') return Promise.resolve({ ok: false, detail: '这台设备没有本地朗读服务' });
    var now = Date.now();
    if (ttsProbed && now - ttsProbedAt < (ttsProbed.ok ? TTS_OK_TTL : TTS_BAD_TTL)) return Promise.resolve(ttsProbed);
    return Promise.resolve(api.alaTtsProbe({ endpoint: cfg.endpoint }))
      .then(function (r) {
        ttsProbed = r || { ok: false };
        ttsProbedAt = Date.now();
        return ttsProbed;
      }, function () {
        ttsProbed = { ok: false, detail: '读不出本地服务' };
        ttsProbedAt = Date.now();
        return ttsProbed;
      });
  }

  /* 念一句：MeloTTS 出声就放音频，出不来就系统语音 */
  /* opts.force：用户手点的"念这段"，不受总开关限制（关了自动朗读也能点着听一段） */
  function speak(text, opts) {
    opts = opts || {};
    var cfg = alaTtsCfg();
    if (!cfg.on && !opts.force) return Promise.resolve({ ok: false, detail: '朗读没开' });
    var txt = speakable(text);
    if (!txt) return Promise.resolve({ ok: false, detail: '没东西可念' });
    /* 正在听用户说话时不插嘴，免得自己的声音被麦克风收进去 */
    if (listening) return Promise.resolve({ ok: false, detail: '正在听你说' });
    stopSpeak();
    /* 标在 stopSpeak 之后：不然刚点亮就被自己清掉 */
    if (opts.el) markSpeak(opts.el);
    /* 嘴先动起来，按字数估个时长兜底：
     * 音频结束会提前关，系统语音秒退时也不会「只闪一下」。 */
    clearTimeout(talkTimer);
    talking(true);
    talkTimer = setTimeout(function () { talking(false); }, Math.max(700, Math.min(20000, txt.length * 190)) + 500);

    return probeTts().then(function (pr) {
      if (!pr || !pr.ok) {
        var sys = speakSystem(txt, cfg.speed);
        return { ok: sys, via: sys ? 'system' : 'none', detail: sys ? '系统语音' : ((pr && pr.detail) || '没有可用的朗读') };
      }
      var api = window.api;
      /* MeloTTS 的中文音色本身偏稳，稍微提一点速，语气才够"冲" */
      var melo = Math.max(0.5, Math.min(2, (Number(cfg.speed) || 1) * 1.05));
      return Promise.resolve(api.alaTts({ text: txt, endpoint: cfg.endpoint, speed: melo }))
        .then(function (r) {
          if (!r || !r.ok || !r.audio) {
            var s2 = speakSystem(txt, cfg.speed);
            return { ok: s2, via: s2 ? 'system' : 'none', detail: (r && r.detail) || '本地服务没给音频' };
          }
          try {
            ttsAudio = new Audio('data:' + (r.mime || 'audio/wav') + ';base64,' + r.audio);
            ttsAudio.onended = function () { ttsSpeaking = false; ttsAudio = null; clearTimeout(talkTimer); talking(false); markSpeak(null); };
            ttsAudio.onerror = function () { ttsAudio = null; ttsSpeaking = false; markSpeak(null); };
            ttsSpeaking = true;
            talking(true);   /* 合成语音播放期间嘴一直在动 */
            var p = ttsAudio.play();
            if (p && typeof p.catch === 'function') {
              p.catch(function () { speakSystem(txt, cfg.speed); });
            }
            return { ok: true, via: 'melo', detail: 'MeloTTS-ZH' };
          } catch (e) {
            var s3 = speakSystem(txt, cfg.speed);
            return { ok: s3, via: s3 ? 'system' : 'none', detail: '放不出来，改用系统语音' };
          }
        }, function () {
          var s4 = speakSystem(txt, cfg.speed);
          return { ok: s4, via: s4 ? 'system' : 'none', detail: '朗读请求失败' };
        });
    });
  }

  function ttsOn() { return alaTtsCfg().on; }

  /* 输入框旁边的小喇叭：点一下开/关，状态写进按钮 */
  function updateTtsUI() {
    var b = document.getElementById('pqb-speak');
    if (!b) return;
    var on = ttsOn();
    b.textContent = on ? '🔊' : '🔈';
    b.title = on ? '朗读：开（阿刺的回答会念出来）' : '朗读：关（点一下让阿刺出声）';
    b.classList.toggle('on', on);
  }

  function toggleSpeak() {
    var on = !ttsOn();
    alaSetTts({ on: on });
    if (on) {
      pushMsg('sys', '朗读开了——我说话会念出来。本地服务没起就用系统中文语音，都能听。');
      speak('朗读开了，我说话会念出来。');
    } else {
      pushMsg('sys', '朗读关了。');
    }
  }

  /* ---------------- 动手能力：接消息 / 制定计划 / 建议改计划 ----------------
   * 只有「接了外接模型」才打开这三件事。规矩定死在代码里：
   *   1) 模型只能出「提议」，阿刺把提议列成卡片，用户点一下才落地；
   *   2) 动作只能引用本机真实存在的计划 id / 搭子 uid，对不上的直接判废；
   *   3) 守护密码照旧——要密码就停下来问，绝不绕过；
   *   4) 删计划一律降级成「停用」，不删库。
   * 没接模型时：接消息回落到原来的拟稿话术，排/改计划直说接模型才能干。 */

  var ALA_CAPS_KEY = 'pq-ala-caps-v1';
  var bridge = null;      /* app.js 注入：计划 / 搭子 / 频道 的读写口 */
  var pendingAct = null;  /* 等守护密码的那批动作 { rest: [...] } */
  var actPw = '';         /* 本次执行用的密码（只在一次重试里活着） */
  var actSeq = 0;

  /* 原始设置（含只读标记与"进只读前的三项"），读不到就给默认 */
  function alaCapsRaw() {
    var d = { plan: true, edit: true, msg: true, ro: false, saved: null };
    try {
      var o = JSON.parse(localStorage.getItem(ALA_CAPS_KEY));
      if (o && typeof o === 'object') {
        for (var k in d) if (typeof o[k] === 'boolean') d[k] = o[k];
        if (o.saved && typeof o.saved === 'object') d.saved = o.saved;
      }
    } catch (e) {}
    return d;
  }

  /* 生效值：只读模式下三项一律视为关——不用用户挨个去点 */
  function alaCaps() {
    var raw = alaCapsRaw();
    if (raw.ro) return { plan: false, edit: false, msg: false };
    return { plan: raw.plan, edit: raw.edit, msg: raw.msg };
  }

  function alaReadOnly() { return !!alaCapsRaw().ro; }
  function alaSetCaps(patch) {
    var o = alaCapsRaw();
    patch = patch || {};
    if (typeof patch.ro === 'boolean' && patch.ro !== o.ro) {
      if (patch.ro) {
        /* 进只读：先把当前三项存起来，出来时原样恢复 */
        o.saved = { plan: o.plan, edit: o.edit, msg: o.msg };
        o.ro = true;
      } else {
        o.ro = false;
        if (o.saved) {
          o.plan = o.saved.plan !== false;
          o.edit = o.saved.edit !== false;
          o.msg = o.saved.msg !== false;
          o.saved = null;
        }
      }
    }
    if (!o.ro) for (var k in { plan: 1, edit: 1, msg: 1 }) {
      if (typeof patch[k] === 'boolean') o[k] = patch[k];
    }
    try { localStorage.setItem(ALA_CAPS_KEY, JSON.stringify(o)); } catch (e) {}
    return alaCaps();
  }
  function capOn(k) { return alaCaps()[k] !== false; }
  function bg() { return bridge || {}; }

  /* 三件事的前提：接了模型（纯查表 / 模型没接上 都不行） */
  function actReady() {
    return !!(window.AlaAct) && alaMode() !== 'table'
      && alaRuntimeCfg().enabled !== false && !!(alaReady && alaReady.ok);
  }

  var CAP_NAME = { plan: '排计划', edit: '改计划', msg: '接消息' };

  function actHint(kind) {
    var what = kind === 'msg' ? '帮你看搭子和频道的消息、起草回复'
      : kind === 'edit' ? '帮你过一遍计划、指出哪儿不合理并给改法'
        : '帮你把今天排成一条条能打勾的计划';
    return '「' + (CAP_NAME[kind] || '动手') + '」得接个模型才行——设置页「阿刺引擎」里接上就成：\n'
      + '· LongCat（美团长猫）：官方站 longcat.ai，开放平台 longcat.chat——注册后每日 10 万免费 token，填个 Key 就能用。搜「美团 LongCat」会被外卖淹，直接输网址；\n'
      + '· 本机 Qwen3-4B：装 Ollama 后 ollama pull qwen3:4b；\n'
      + '· 自定义模型：填任意 Ollama / OpenAI 兼容地址。\n'
      + '接上之后我就能' + what + '——不过每一条都得你点头我才动手。';
  }

  /* ---------- 资料：模型只能看这些 ---------- */

  function planFactsForAct(text) {
    var t = todayStats();
    var s = (typeof getState === 'function' && getState()) || {};
    var lines = [alaFacts({ withIds: true, text: text || '' })];
    /* 不在今天、但可能要改的计划：只给前 10 条，省 token */
    var todayIds = {};
    for (var i = 0; i < t.plans.length; i++) if (t.plans[i] && t.plans[i].id) todayIds[t.plans[i].id] = 1;
    var all = Array.isArray(s.plans) ? s.plans : [];
    var others = [];
    for (var j = 0; j < all.length && others.length < 10; j++) {
      var q = all[j];
      if (!q || !q.id || todayIds[q.id]) continue;
      others.push(q);
    }
    if (others.length) {
      lines.push('', '【其它计划（不在今天）】');
      for (var k = 0; k < others.length; k++) {
        var o = others[k];
        lines.push('id=' + o.id + ' ｜ ' + (o.title || '') + ' ｜ '
          + (o.when === 'boot' ? '开机提醒' : (o.time || '—')) + ' ｜ +' + (o.points || 0) + ' 分 ｜ '
          + (o.enabled === false ? '已停用' : '启用中'));
      }
    }
    return lines.join('\n');
  }

  function readFriendMsgs(uid) {
    return new Promise(function (resolve) {
      var api = window.api;
      if (!api || typeof api.friendMsgs !== 'function') return resolve([]);
      Promise.resolve(api.friendMsgs(uid)).then(function (r) {
        var list = (r && r.msgs) || [];
        resolve(list.filter(function (m) { return m && m.text && m.kind !== 'remind'; }));
      }, function () { resolve([]); });
    });
  }

  function friendCacheNow() {
    try { var f = bg().friends ? bg().friends() : null; return f && f.friends ? f : null; } catch (e) { return null; }
  }

  /* 好友数据平时只在「好友区」刷，阿刺要用就得自己拉一次（不然搭子列表永远是空的） */
  var friendLive = null;
  function loadFriends() {
    var api = window.api;
    if (!api || typeof api.friendState !== 'function') return Promise.resolve(null);
    return Promise.resolve(api.friendState()).then(function (fr) {
      if (fr && fr.friends) friendLive = fr;
      return friendLive;
    }, function () { return friendCacheNow(); });
  }
  function friendsNow() { return friendLive || friendCacheNow(); }

  function friendBlocks() {
    var fr = friendsNow();
    var me = (fr && fr.me && fr.me.uid) || '';
    var uids = fr ? Object.keys(fr.friends).slice(0, 5) : [];
    var jobs = uids.map(function (uid) {
      var f = (fr.friends[uid] || {});
      return readFriendMsgs(uid).then(function (msgs) {
        var head = 'uid=' + uid + ' ｜ 昵称=' + (f.alias || '搭子')
          + ' ｜ ' + (Number(f.tier) === 2 ? '战友档' : '搭子档')
          + ' ｜ 对方今日完成率 ' + (Number(f.peerRate) || 0) + '%';
        if (!msgs.length) return head + '\n    （还没聊过）';
        var rows = msgs.slice(-5).map(function (m) {
          var who = me && m.uid === me ? '我' : (m.alias || 'TA');
          return '    ' + who + '：' + String(m.text || '').slice(0, 60);
        });
        return head + '\n' + rows.join('\n');
      });
    });
    return Promise.all(jobs).then(function (blocks) {
      return { uids: uids, blocks: blocks };
    });
  }

  function channelBlockForAct() {
    try {
      var C = window.PQLegionChannel;
      if (!C || typeof C.state !== 'function') return '';
      var s = C.state();
      if (!s || !s.code) return '';
      var log = Array.isArray(s.log) ? s.log : [];
      var me = (s.self && s.self.uid) || '';
      var msgs = log.filter(function (m) { return m && !m.sys && m.text; }).slice(-8);
      if (!msgs.length) return '';
      var rows = msgs.map(function (m) {
        return '  ' + (me && m.uid === me ? '我' : (m.alias || '成员')) + '：' + String(m.text || '').slice(0, 50);
      });
      return '【军团频道最近消息】回频道时 to 写 #channel\n' + rows.join('\n')
        + '\n  当前能发言：' + (s.canSend ? '是' : '否（' + (s.why || '受限') + '）');
    } catch (e) { return ''; }
  }

  function msgFactsForAct(text) {
    return loadFriends().then(function () {
      return friendBlocks();
    }).then(function (r) {
      var lines = [alaFacts({ text: text || '' }), '', '【搭子私聊】uid 必须原样引用，回复哪个人就把 to 写成那个 uid'];
      if (!r.uids.length) lines.push('（还没有搭子）');
      for (var i = 0; i < r.blocks.length; i++) lines.push(r.blocks[i]);
      var ch = channelBlockForAct();
      lines.push('', ch || '【军团频道】读不到（没加入军团，或频道没开）');
      return lines.join('\n');
    });
  }

  function actPlans() {
    var s = (typeof getState === 'function' && getState()) || {};
    var t = todayStats();
    var out = [], seen = {};
    var pool = (t.plans || []).concat(Array.isArray(s.plans) ? s.plans : []);
    for (var i = 0; i < pool.length; i++) {
      var p = pool[i];
      if (!p || !p.id || seen[p.id]) continue;
      seen[p.id] = 1;
      out.push({ id: p.id, title: p.title || p.name || '', time: p.time, points: p.points });
    }
    return out;
  }

  function actCtx() {
    var fr = friendsNow();
    var uids = fr ? Object.keys(fr.friends) : [];
    var names = {};
    for (var i = 0; i < uids.length; i++) names[uids[i]] = (fr.friends[uids[i]] || {}).alias || '';
    var ch = channelBlockForAct();
    return { plans: actPlans(), friends: uids, friendNames: names, channel: !!ch };
  }

  /* ---------- 模型调用（动手版：放宽输出长度，容得下动作 JSON） ---------- */

  function alaActAsk(kind, text, facts) {
    var mod = window.AlaAct;
    var llm = window.AlaLLM;
    if (!mod || !llm) return Promise.resolve(null);
    var cfg = alaRuntimeCfg();
    if (cfg.enabled === false) return Promise.resolve(null);
    var msgs = mod.buildMessages(kind, text, facts, alaHist);
    var opts = { maxTokens: 900, maxChars: 2400, temperature: 0.4 };
    return new Promise(function (resolve) {
      function done(r) {
        var txt = r && r.text ? r.text : null;
        if (txt) {
          alaHist.push({ role: 'user', content: String(text).slice(0, 800) });
          alaHist.push({ role: 'assistant', content: String(txt).slice(0, 600) });
          trimHist();
        }
        resolve(txt);
      }
      if (window.api && typeof window.api.alaAsk === 'function') {
        window.api.alaAsk({ cfg: cfg, messages: msgs, opts: opts }).then(done, function () { resolve(null); });
      } else {
        llm.ask(cfg, msgs, llm.fetchTransport(), opts).then(done, function () { resolve(null); });
      }
    });
  }

  /* ---------- 时间 / 星期兜底：别把计划排到已经过去的时间 ---------- */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fixTime(t) {
    var d = new Date();
    var cur = d.getHours() * 60 + d.getMinutes();
    var mt = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    var want = mt ? Number(mt[1]) * 60 + Number(mt[2]) : Math.ceil((cur + 30) / 30) * 30;
    if (want < cur + 5) want = Math.ceil((cur + 20) / 30) * 30; /* 排到过去 = 一建出来就"已错过" */
    if (want > 23 * 60 + 55) want = 23 * 60 + 55;
    return pad2(Math.floor(want / 60)) + ':' + pad2(want % 60);
  }

  function withToday(days) {
    var wd = new Date().getDay();
    var arr = Array.isArray(days) ? days.slice() : [];
    if (arr.indexOf(wd) < 0) arr.push(wd); /* 用户要的是"今天"，那今天必须算进去 */
    return arr.sort(function (a, b) { return a - b; });
  }

  /* ---------- 改计划：不用叫模型的那几种 ----------
   * 用户定的分工：排计划必须模型（见 alaAct）；改计划的「改到几点 / 积分改多少 / 停用哪条」
   * 从口令里就解析得出来，没必要烧 token、也不该因为模型没接就干不了。
   * 只有「看合不合理」这种要判断的，才回到模型那条路。 */

  var CN_DIGIT = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

  /* 用户这句话里到底"要排什么" —— 剥掉口令词后剩下的才是真正的内容（主题也算内容） */
  function planBrief(text) {
    return String(text || '')
      .replace(/帮我|给我|你|能不能|可以|麻烦|请|想要|想|要/g, '')
      .replace(/排一下|排个计划|排计划|排|制定|定个计划|定一个|定个|做个计划|做一个|来一个|搞一个|规划一下|安排一下|列个清单|列一下|安排/g, '')
      .replace(/今天|今日|一下|的计划|计划|的任务|任务|的事情|事情|清单|一个/g, '')
      .replace(/[，。！？、,.!?：:；;\s"“”'']/g, '');
  }

  function findPlanIn(text, plans) {
    var best = null, bestLen = 0;
    var t0 = String(text || '');
    for (var i = 0; i < plans.length; i++) {
      var p = plans[i];
      var full = String((p && (p.title || p.name)) || '');
      if (!full) continue;
      var cands = [full].concat(full.split(/[\s,，、/·]+/));
      for (var j = 0; j < cands.length; j++) {
        var c = String(cands[j] || '').trim();
        if (c.length < 2) continue;              /* 一个字的不认，免得瞎命中 */
        if (t0.indexOf(c) >= 0 && c.length > bestLen) { best = p; bestLen = c.length; }
      }
    }
    return best;
  }

  function cnNum(s) {
    s = String(s || '');
    if (/^\d+$/.test(s)) return Number(s);
    if (s === '十') return 10;
    if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN_DIGIT[s[1]];
    if (/^[一二三四五六七八九]十$/.test(s)) return CN_DIGIT[s[0]] * 10;
    if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(s)) return CN_DIGIT[s[0]] * 10 + CN_DIGIT[s[2]];
    return CN_DIGIT[s];
  }

  function findTimeIn(text) {
    var t = String(text || '');
    var m = /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[:：点]\s*(\d{1,2})?\s*(半)?/.exec(t);
    if (!m) return '';
    var h = cnNum(m[1]);
    if (!isFinite(h)) return '';
    /* "晚上八点" 不能当成早上八点 */
    if (h < 12 && /晚上|下午|傍晚|夜里|今晚/.test(t)) h += 12;
    var mi = m[3] ? 30 : (m[2] == null || m[2] === '' ? 0 : Number(m[2]));
    if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return '';
    return pad2(h) + ':' + pad2(mi);
  }

  function findPointsIn(text) {
    var t = String(text || '');
    var m = /(?:积分|分数|分值)\s*(?:改|设|调|降|提|变|加|减)?\s*(?:成|为|到)?\s*(\d{1,3})/.exec(t)
      || /(?:改成|改到|设为|调到|变成|给)\s*(\d{1,3})\s*分/.exec(t);
    if (!m) return null;
    var n = Number(m[1]);
    if (!isFinite(n)) return null;
    return Math.max(5, Math.min(200, Math.round(n)));
  }

  /* 返回 { actions, why, plan } —— actions 非空就完全不用模型 */
  function parseLocalEdit(text) {
    var plans = actPlans();
    if (!plans.length) return { actions: [], why: 'empty' };
    var t = String(text || '');
    var hit = findPlanIn(t, plans);
    if (!hit) return { actions: [], why: 'nomatch' };
    if (/停用|暂停|删了|删掉|删除|不要了|去掉|取消/.test(t)) {
      return { actions: [{ act: 'plan.drop', id: hit.id, title: hit.title || '', why: '你让停的' }] };
    }
    var patch = {};
    var tm = findTimeIn(t);
    if (tm && tm !== String(hit.time || '')) patch.time = tm;
    var pts = findPointsIn(t);
    if (pts != null && pts !== Number(hit.points)) patch.points = pts;
    if (!Object.keys(patch).length) return { actions: [], why: 'nointent', plan: hit };
    return { actions: [{ act: 'plan.edit', id: hit.id, title: hit.title || '', patch: patch }] };
  }

  /* 能当场解析成动作就当场给卡片；返回解析结果，调用方据此决定要不要叫模型 */
  function tryLocalEdit(text) {
    var local = parseLocalEdit(text);
    if (!local.actions.length) return local;
    if (!capOn('edit')) {
      pushMsg('bud', '改计划这项你在设置里关掉了（阿刺引擎 → 动手能力）。');
      return { actions: [], why: 'off' };
    }
    pushMsg('bud', pick(['这个不用叫模型，我直接给你改。', '看得懂，我直接动——你看一眼再点头。']));
    pushActCard(local.actions);
    setMood('smirk', 4000);
    return local;
  }

  function editAskBack(plan) {
    return '「' + ((plan && (plan.title || plan.name)) || '这条') + '」要改成什么？说清楚：改到几点、积分改多少，或者直接说停用。'
      + '\n（想听我评一评整套计划合不合理，那个才需要模型。）';
  }

  /* ---------- 入口 ---------- */

  function alaAct(kind, text) {
    text = String(text || '');
    if (!capOn(kind)) {
      pushMsg('bud', '这件事你在设置里关掉了（阿刺引擎 → 动手能力）。想让我干，就去打开。');
      return;
    }

    /* 改计划：能当场解析的一律不走模型 */
    if (kind === 'edit') {
      var local = tryLocalEdit(text);
      if (local.actions.length || local.why === 'off') return;
      if (local.why === 'empty') {
        pushMsg('bud', '你今天一条计划都没有，改什么？先建两条再说。');
        return;
      }
      if (local.why === 'nointent') {
        pushMsg('bud', editAskBack(local.plan));
        return;
      }
    }

    /* 排计划：先得知道你要排什么，再叫模型 —— 光一句"帮我排计划"排出来全是废话。
     * 说主题也算说清楚（"帮我定一个减肥计划"），模型会把主题拆成详细条目。 */
    if (kind === 'plan') {
      var brief = planBrief(text);
      if (brief.length < 2) {
        pushMsg('bud', '排什么？两种都行：\n'
          + '· 给我主题 —— 「帮我定一个减肥计划」「帮我排一个考前一周的复习计划」，我拆成今天能动手的几条；\n'
          + '· 给我条目 —— 「帮我排：晨读 20 页、跑步 3 公里、晚上复盘」。\n'
          + '只说"帮我排计划"的话，我排出来的东西你也不会做。');
        setMood('smirk', 4000);
        return;
      }
    }

    if (!actReady()) {
      if (kind === 'msg') {
        var d = ruleByKey('draft');
        pushMsg('bud', d ? tableOut(d, null, { text: text }) : actHint('msg'));
      } else {
        pushMsg('bud', actHint(kind));
      }
      setMood('idle', 4000);
      return;
    }
    pushMsg('sys', kind === 'msg' ? '正在翻最近的搭子和频道消息…'
      : kind === 'edit' ? '正在过一遍你今天的计划…' : '正在给你排队形…');
    setMood('listen', 0);
    var factsP = kind === 'msg' ? msgFactsForAct(text) : Promise.resolve(planFactsForAct(text));
    factsP.then(function (facts) {
      return alaActAsk(kind, text, facts).then(function (raw) {
        if (!raw) {
          pushMsg('bud', '模型这会儿没答上来（' + ((alaReady && alaReady.detail) || '连接不稳') + '）。'
            + (kind === 'msg' ? '先把这条消息自己回了吧，我不替你瞎猜。' : '等下再说一遍，我再看。'));
          setMood('idle', 3000);
          return;
        }
        var got = window.AlaAct.parse(raw, kind);
        var actions = window.AlaAct.normAll(got.actions, actCtx());
        if (kind === 'plan') actions = adjustForWeather(actions, text);
        if (got.say) pushMsg('bud', got.say);
        if (!actions.length) {
          pushMsg('sys', got.actions.length
            ? '模型给的动作对不上本机数据，我一条都没让它动——宁可不动，也不能瞎改你的计划。'
            : '这一轮没有要动手的事。');
          setMood('idle', 3000);
          return;
        }
        pushActCard(actions);
        setMood('happy', 5000);
      });
    }).catch(function () {
      pushMsg('bud', '刚才那一下没走通。再说一遍，或者先去设置页看看模型状态。');
      setMood('idle', 3000);
    });
  }

  /* ---------- 动作卡片：勾选 → 点头 → 才落地 ---------- */

  function pushActCard(actions) {
    var A = window.AlaAct;
    if (!msgsEl) return;
    var d = document.createElement('div');
    d.className = 'pqb-act';
    d.id = 'pqb-act-' + (++actSeq);
    var rows = actions.map(function (a, i) {
      return '<label class="pqb-act-row"><input type="checkbox" checked data-i="' + i + '">'
        + '<span>' + esc(A.describe(a)) + '</span></label>';
    });
    d.innerHTML = '<div class="pqb-act-h">我要这么做（' + actions.length + ' 步）· 你点头我才动手</div>'
      + rows.join('')
      + '<div class="pqb-act-foot"><button class="pqb-act-go">就这么办</button>'
      + '<button class="pqb-act-no">算了</button></div>'
      + '<div class="pqb-act-tip"></div>';
    msgsEl.appendChild(d);
    msgsEl.scrollTop = msgsEl.scrollHeight;

    var go = d.querySelector('.pqb-act-go');
    var no = d.querySelector('.pqb-act-no');
    go.onclick = function () {
      var picked = [];
      var boxes = d.querySelectorAll('input[data-i]');
      for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) picked.push(actions[Number(boxes[i].dataset.i)]);
      if (!picked.length) { d.querySelector('.pqb-act-tip').textContent = '一条都没勾——那就先不动。'; return; }
      go.disabled = true;
      no.disabled = true;
      go.textContent = '正在办…';
      runActions(picked, d);
    };
    no.onclick = function () {
      d.querySelector('.pqb-act-foot').innerHTML = '<span class="pqb-act-done">行，那就不动。</span>';
      d.querySelector('.pqb-act-tip').textContent = '';
      pushMsg('sys', '动作已作废，你的计划一个字没改。');
    };
  }

  function runOne(a) {
    var md = bg();
    if (a.act === 'plan.add') {
      if (typeof md.addPlan !== 'function') return Promise.resolve({ ok: false, message: '这台设备不支持建计划' });
      var payload = {
        title: a.title,
        desc: a.desc || '',
        icon: a.icon || '🎯',
        color: 'indigo',
        when: 'time',
        time: fixTime(a.time),
        days: withToday(a.days),
        points: a.points,
        allowProcs: [],
        needConfirm: false,
        enabled: true,
      };
      return Promise.resolve(md.addPlan(payload, actPw));
    }
    if (a.act === 'plan.edit') {
      if (typeof md.editPlan !== 'function') return Promise.resolve({ ok: false, message: '这台设备不支持改计划' });
      var patch = {};
      var src = a.patch || {};
      for (var k in src) patch[k] = src[k];
      /* 改到已经过去的时间 = 一改完就"已错过"，照样往后推 */
      if (patch.time) patch.time = fixTime(patch.time);
      return Promise.resolve(md.editPlan(a.id, patch, actPw));
    }
    if (a.act === 'plan.drop') {
      if (typeof md.dropPlan !== 'function') return Promise.resolve({ ok: false, message: '这台设备不支持停用计划' });
      return Promise.resolve(md.dropPlan(a.id, actPw));
    }
    if (a.act === 'msg.reply') {
      if (typeof md.sendMsg !== 'function') return Promise.resolve({ ok: false, message: '这台设备发不了消息' });
      return Promise.resolve(md.sendMsg(a.to, a.text));
    }
    return Promise.resolve({ ok: false, message: '不认识这个动作' });
  }

  async function runActions(list, card) {
    var A = window.AlaAct;
    var tip = card ? card.querySelector('.pqb-act-tip') : null;
    var okN = 0, badN = 0, needPw = false, stopAt = -1;
    for (var i = 0; i < list.length; i++) {
      if (tip) tip.textContent = '正在办：' + A.describe(list[i]).slice(0, 36) + '…';
      var r = await runOne(list[i]);
      if (r && r.needPassword) { needPw = true; stopAt = i; break; }
      if (r && r.ok) okN++;
      else {
        badN++;
        pushMsg('sys', '这一步没成：' + A.describe(list[i]) + '（' + ((r && r.message) || '没通过校验') + '）');
        if (list[i].act === 'msg.reply' && typeof scold === 'function') scold('chat', (r && r.message) || '频道/门槛把你拦了');
      }
    }
    actPw = '';
    if (card) {
      var foot = card.querySelector('.pqb-act-foot');
      if (foot) {
        foot.innerHTML = '<span class="pqb-act-done">' + (okN || badN
          ? '已办 ' + okN + ' 个' + (badN ? '，' + badN + ' 个没成' : '')
          : '先停一下') + '</span>';
      }
      if (tip) tip.textContent = '';
    }
    if (needPw) {
      pendingAct = { rest: list.slice(stopAt) };
      pushMsg('sys', '这一步要守护密码。在下面输入「密码 你的密码」，我接着办（输入「取消」就作废）。');
      setMood('idle', 3000);
      return;
    }
    if (okN) {
      pushMsg('bud', pick([
        '办完了，' + okN + ' 件。别只看着我动——轮到你了。',
        '好了，' + okN + ' 件都给你办了。剩下的靠你打勾，我只负责动嘴。',
      ]));
      setMood('happy', 4200);
    } else if (badN) {
      pushMsg('bud', '一个都没办成。不是我不动，是规矩没让——上面写了为什么。');
      setMood('angry', 3600);
    }
  }

  /* 等密码时：用户回「密码 xxx」就接着办，「取消」就作废 */
  function resumeWithPassword(pw) {    var p = pendingAct;
    pendingAct = null;
    actPw = String(pw || '');
    if (!actPw) { pushMsg('sys', '密码是空的，动作作废。'); return; }
    pushMsg('sys', '收到，正在办…');
    runActions(p.rest, null).then(function () {
      if (pendingAct) pushMsg('sys', '密码还是不对。再说一次「密码 你的密码」，或者「取消」。');
    });
  }

  /* ---------------- 被警告 / 被禁言 / 被拦截：毒舌提醒 ----------------
   * 规矩在别处执行，毒舌在这里补刀。app.js 在这些事件发生时调 PQBuddy.scold(kind, detail)。 */

  var SCOLDS = {
    warn: ['嘴上没把门，警告先挂账上——再犯就不是提醒了。', '这不是我说的，是规矩说的。管住手，省得管嘴。'],
    mute: ['禁言了。正好，用打字的时间去打卡，回来咱们都体面。', '嘴被按住了吧？仙人掌不说话都能活，你也可以。'],
    chat: ['这条没发出去——不是网的问题，是你的档位/完成率问题。先干活，频道不会跑。', '频道把你拦下了。理由人家写了，自己看。想说话？先把今天的事做完。'],
    friend: ['搭子那边没收到。门槛拦的是你，不是我——先把自己的完成率拉上来。', '消息被档了。你们俩的规矩是双方完成率 ≥50% 才能聊，这不是我定的，但我是拥护者。'],
    planban: ['计划包被拦了。黑名单不是摆设，你这包我救不了。', '包被拦了。来路不明的计划文件就该这么办——你该谢谢拦截你的人。'],
    evict: ['驱逐投票挂头上了。别急着骂人，备好申诉材料——或者干脆把打卡补上，比什么都硬。'],
  };
  var scoldLast = {};

  function scold(kind, detail) {
    var lines = SCOLDS[kind] || SCOLDS.warn;
    var now = Date.now();
    if (scoldLast[kind] && now - scoldLast[kind] < 2 * 60e3) return; /* 同类提醒 2 分钟内不叠嘴 */
    scoldLast[kind] = now;
    var line = lines[Math.floor(Math.random() * lines.length)];
    pushMsg('bud', '⚠️ ' + line + (detail ? '\n（' + detail + '）' : ''));
    setMood('angry', 5200);
    var badge = document.querySelector('#pqb-fab .pqb-badge');
    if (badge && !open) badge.style.display = 'block';
  }

  var BRAIN = [
    { k: 'watch', re: /盯学|监考|摄像头.*盯|抓拍|闲聊雷达|摸鱼检测/, mood: 'idle',
      fn: function () {
        var s = window.AIChat && AIChat.status ? AIChat.status() : null;
        var w = window.AIWatch && AIWatch.isRunning ? AIWatch.isRunning() : false;
        var lines = ['原有的 AI 三件套都在：'];
        lines.push('· 闲聊雷达：' + (s && s.ready ? '已就绪（本地模型）' : '首次进自习房时会自动加载（约几十秒）'));
        lines.push('· AI 盯学：' + (w ? '正在盯（已抓包 ' + (AIWatch.s() ? AIWatch.s().triggers : 0) + ' 次）' : '在自习房开摄像头即自动开启'));
        lines.push('· 自训练：设置页里一句话训出自己的模型。');
        lines.push('要不要我带你去自习房？说「打开自习」就行。');
        return lines.join('\n');
      } },
    { k: 'train', re: /训练|自训练|我的模型|教它/, mood: 'happy',
      fn: function () {
        var c = window.AITrain && AITrain.counts ? AITrain.counts() : null;
        var head = '自训练是把你纠正过的样本喂给本地模型：';
        var body = c ? ('文字样本 ' + (c.text || 0) + ' 条，画面样本 ' + (c.image || 0) + ' 条。') : '样本会存在本机，不上云（除非你主动开云同步）。';
        if (typeof navFn === 'function') setTimeout(function () { try { navFn('settings'); } catch (e) {} }, 350);
        return head + '\n' + body + '\n这就带你去「设置」，往下拉到 AI 自训练。';
      } },
    { k: 'nav', re: /(?:打开|帮我?打开|去|切换到?|带我去|看看)\s*(今日|主页|首页|计划|目标|里程碑|自习|自习房|房间|军团|PK|守护|强制|统计|热力图|数据|设置|商城|主题)/i, mood: 'happy',
      fn: function (m) {
        var word = String(m[1] || '');
        var hit = null;
        for (var i = 0; i < NAVS.length; i++) if (NAVS[i].re.test(word)) { hit = NAVS[i]; break; }
        if (!hit) return '这个页面我翻不到，老实说比硬跳强。';
        if (typeof navFn === 'function') {
          setTimeout(function () { try { navFn(hit.v); } catch (e) {} }, 350);
          return '这就带你去「' + hit.t + '」页。到了之后——看归看，别只看不做。';
        }
        return '这台设备翻不了页，你自己点左边那排。';
      } },
    { k: 'autofill', re: /自动填|帮我填|代填|登录数据|不用手动/, mood: 'happy',
      fn: function () {
        var n = autofillForms();
        return n > 0
          ? '填好了 ' + n + ' 个空（昵称/姓名类，从本机数据带出来的）。邮箱手机号我不猜——猜错比不填更麻烦。'
          : '没找到能填的空。把要填的表单点开再叫我，我只认「昵称/姓名/名字/监督人」这类框。';
      } },
    { k: 'alamsg', act: 'msg', mood: 'listen',
      re: /接(一下)?消息|帮我看(看)?消息|帮我回|替我回|代我回|代回|回一下(他|她|TA)|帮他回|回复(一下)?(搭子|好友|频道|军团|群)|怎么回(复)?/i },
    { k: 'alaplan', act: 'plan', mood: 'listen',
      re: /帮我排|给我排|排一下|排个计划|排计划|制定(个)?计划|定个计划|做个计划|规划一下|帮我安排|安排一下|今天怎么安排|列个清单|列一下今天/ },
    { k: 'alaedit', act: 'edit', mood: 'listen',
      re: /改(一下|改)?计划|调整(一下)?计划|计划.*(不合理|有问题|太多|冲突|要改|改一下)|帮我(看看|过一遍).*计划|计划.*(建议|意见)|改到|改成|调到|挪到|提前到|推迟到|停用|暂停掉|删掉.{0,15}(计划|任务)|积分改|分数改/ },
    { k: 'draft', re: /帮我回|代我回|代回|回复建议|怎么回/, mood: 'happy',
      fn: function () {
        var t = todayStats();
        var rate = t.total ? Math.round((t.done / t.total) * 100) : 0;
        var h = new Date().getHours();
        var span = h < 12 ? '中午' : h < 18 ? '下午' : '晚上';
        var lines = ['「我在打卡，还剩 ' + t.left + ' 项，' + span + '回你。」'];
        lines.push(rate < 50
          ? '「完成率才 ' + rate + '%，频道都被我聊成静默档了——先各自干活，' + span + '聊。」'
          : '「今天完成率 ' + rate + '%，能聊几句。有正事先说正事。」');
        lines.push('「截图为证，打卡完成。」');
        return '帮你拟了三条，挑一条贴过去（都能过闲聊雷达）：\n' + lines.join('\n');
      } },
    { k: 'help', re: /你能干(什么|嘛)|怎么用|会什么|帮什么|功能/, mood: 'idle',
      fn: function () {
        var head = '本机就干的四件事：\n① 带路 —— 说「打开计划」「去军团」直接跳页；\n② 汇报 —— 问进度 / 积分 / 连击 / 今天安排，全部现场算，不编数；\n'
          + '③ 毒舌 —— 摆烂时接住你，给一条今天就能做的建议；\n④ 原有 AI 的管家 —— 闲聊雷达、AI 盯学、自训练的状态问我就行。\n';
        var act = actReady()
          ? '接上模型后多三件：\n· 接消息 —— 说「帮我看看消息」「帮我回一下」；\n· 排计划 —— 说「帮我排今天的计划」；\n· 改计划 —— 说「看看我的计划合不合理」。\n这三件我都只出提议，你点头才落地。\n'
          : '接上模型还能替你动手：接消息、排计划、改计划（设置页「阿刺引擎」里接）。\n';
        return head + act + '点麦克风可以用说的，识别在本机，不出设备。';
      } },
    { k: 'mute', re: /闭嘴|别说话|安静|吵死了/, mood: 'sleep',
      say: ['行，我挂机。想让我回来就说「醒醒」。', '安静模式。仙人掌本来就是最安静的植物。'] },
    { k: 'wake', re: /醒醒|回来|说话/, mood: 'happy',
      say: ['回来了。刚才安静得我都快生根了。', '哟，舍得让我开口了？'] },
    { k: 'name', re: /(?:叫我|记得我叫|我名字是|我是)\s*([\u4e00-\u9fa5a-zA-Z0-9]{1,8})(?:[，。!！]|$)/, mood: 'happy',
      fn: function (m) {
        mem.name = m[1];
        if (mem.name === '阿刺') { mem.name = ''; saveMem(); return '这名字是我的，抢名字这种事仙人掌记一辈子。'; }
        saveMem();
        return '记住了，' + mem.name + '。放心，我记性比你的打卡记录稳。';
      } },
    { k: 'whoami', re: /你是谁|你叫什么|什么玩意|什么鬼东西|介绍.*自己/, mood: 'smirk',
      say: ['阿刺，你的战友——一盆长在计划软件里的仙人掌。工作内容：盯你摸鱼，顺便毒舌。', '我是阿刺，不是宠物，是跟你并肩的搭档。浇水是给我补协作能量，不浇我也照样陪你。'] },
    { k: 'greet', re: /你好|您好|在吗|嗨[啊呀~]?|哈喽|hello|hi\b/i, mood: 'happy',
      fn: function () { return pick(['哟，搭档' + (nameOf() && nameOf() !== '你' ? nameOf() : '') + '。找我有事，还是单纯想听毒舌？', '在。战友随叫随到，不用睡觉。']); } },
    { k: 'thanks', re: /谢谢|多谢|辛苦|辛苦了/, mood: 'happy',
      say: ['谢什么，把你今天的计划清了比什么都强。', '客气。要谢就拿打卡记录来谢。'] },
    { k: 'praise', re: /你真棒|你真厉害|好厉害|真牛|666|太强了|可爱/, mood: 'happy',
      say: ['知道。但仙人掌不能骄傲，一骄傲就浇水过度。', '行，这句我记下了。下回你摆烂的时候我念给你听。'] },
    { k: 'insult', re: /笨|蠢|傻|垃圾|废物|没用|丑|讨厌你|有病|神经病|滚开|滚远|闭嘴吧|烦不烦|无聊死|你个/, mood: 'angry',
      fn: function () {
        mem.roasts = (mem.roasts || 0) + 1;
        saveMem();
        if (mem.roasts >= 5) return '行，骂够了？我再毒也是盆植物，你骂完还得自己去打卡。咱俩谁更惨一目了然。';
        if (mem.roasts >= 2) return '又骂。我数着呢，已经 ' + mem.roasts + ' 次了——这账我记在花盆底下。';
        return '骂仙人掌，出息。有这力气把今天最后一个计划点完，我当你没说过。';
      } },
    { k: 'points', re: /多少分|积分|分数|还剩几|分够/, mood: 'idle',
      fn: function () {
        var t = todayStats();
        if (!t.total && !t.pts) return '本机还没有积分数据。先建个计划，别急着问我账本。';
        var tone = t.pts >= 0 ? '正分' : '负分';
        return (t.pts < 0 ? '现在 ' + t.pts + ' 分，在坑里。' : '现在 ' + t.pts + ' 分，' + tone + '。') + '\n数据是本机的，我不会算错——也不会替你改。';
      } },
    { k: 'progress', re: /进度|打卡了吗|完成了吗|还剩|今天做了|做了多少/, mood: 'idle',
      fn: function () {
        var t = todayStats();
        if (!t.total) return '今天还没有计划。一片空白的日程问进度，这是在为难一盆仙人掌。';
        if (t.left === 0) return '今天 ' + t.total + ' 项全清了。问吧，随便问，今天你问不倒我。';
        return '今天 ' + t.done + '/' + t.total + '，还剩 ' + t.left + ' 项。\n剩下的别攒到睡前——睡前的你和现在的你，战斗力差三倍。';
      } },
    { k: 'streak', re: /连击|连续|坚持几天|断了没/, mood: 'idle',
      fn: function () {
        var t = todayStats();
        if (!t.streak) return '还没有连击记录。不是批评，是起点——今天打一个，明天来问我就有数了。';
        return '连续 ' + t.streak + ' 天' + (t.best > t.streak ? '（最长纪录 ' + t.best + ' 天）' : '，正在创纪录') + '。\n连击这东西，断了不扣分，但你自己知道亏。';
      } },
    { k: 'plans', re: /今天.*计划|有什么.*做|安排|要做啥|干什么/, mood: 'idle',
      fn: function () {
        var t = todayStats();
        if (!t.total) return '今天没排计划。日程空着不是自由，是把选择权交给了惰性。';
        var lines = [];
        for (var i = 0; i < t.plans.length && lines.length < 6; i++) {
          var p = t.plans[i];
          var nm = p && (p.title || p.name);
          if (nm) lines.push((p.status === 'done' ? '✅ ' : '⬜ ') + nm);
        }
        return '今天 ' + t.total + ' 项：\n' + lines.join('\n') + (t.plans.length > 6 ? '\n…其余的自己看「今日」页。' : '');
      } },
    { k: 'giveup', re: /不想学|不想做|好累|太累|坚持不|放弃了?|摆烂|躺平|烦死了|emo/, mood: 'worried',
      fn: function () {
        var t = todayStats();
        var tip = t.left > 0 ? '把剩下最小的一项做 5 分钟，就 5 分钟，做完来找我。' : '今天就到这，去睡觉，明天把量减半重启。';
        return '累了就歇，这个不丢人，我也不扣你分。\n但歇和放弃是两回事：歇完回来，' + tip + '\n——毒舌归毒舌，咱俩是一伙的。';
      } },
    { k: 'joke', re: /笑话|讲个.*听|逗我|无聊/, mood: 'smirk',
      say: ['讲个真的：有个人给仙人掌浇水浇太多，把它淹死了。你就是那盆，目标太多反而活不成。', '我最大的笑话就是你「稍后开始」这三个字，我听了 ' + ((mem.chats || 0) + 1) + ' 遍了。'] },
    { k: 'time', re: /几点|时间|几号|星期几|今天日期/, mood: 'idle',
      fn: function () {
        var d = new Date();
        var wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
        return d.getHours() + ' 点 ' + d.getMinutes() + ' 分，周' + wd + '。\n本机时钟，准确。要不要顺便看看今天还剩几项？';
      } },
    { k: 'legion', re: /军团|PK|对战|比赛|公会/, mood: 'smirk',
      fn: function () {
        try {
          if (window.PQLegion && PQLegion.info().joined) {
            var inf = PQLegion.info();
            var lines = ['你在一个军团里（军团码 ' + (inf.code || '??') + '），数据只在你和同路人之间点对点走，不经服务器。'];
            var agg = inf.agg;
            if (agg && agg.n) lines.push('军团 ' + agg.n + ' 人，今天 ' + agg.today.checked + ' 人已打卡。');
            return lines.join('\n');
          }
        } catch (e) {}
        return '没加入军团。军团和 PK 都是同路人之间的事，没加入就一个包都不发——这个我可以担保。';
      } },
    { k: 'rescue', re: /点灯|救援|领灯/, mood: 'idle',
      fn: function () {
        var t = todayStats();
        return t.pts < 0
          ? '你在负分区。军团页「翻车救援」里每天能领一盏灯（+5 分），别不好意思，池子就是给这时候用的。'
          : '点一盏灯要掏 5 分（每天最多 3 盏），给正在负分的同路人。军团页里自己点。';
      } },
    { k: 'nodata', re: /天气|股票|新闻|彩票|汇率|今天穿什么/, mood: 'smirk',
      say: ['这我一个盆栽查不了，也不会编。本机没有的数据，我张嘴就是谎——不干。', '别问一个仙人掌天气。我能查的只有你自己的打卡记录，那才是跟我有关的事。'] },
    { k: 'encourage', re: /加油|鼓励我|夸夸我|激励/, mood: 'happy',
      fn: function () {
        var t = todayStats();
        return t.done > 0
          ? '今天已经干成 ' + t.done + ' 件事了，还用我夸？把剩下的清完，今晚你就是自己的骄傲。'
          : '夸奖要拿打卡记录换。先去干一件，干完回来，我夸得比谁都肉麻。';
      } },
    { k: 'alamodel', re: /开启模型|打开模型|关闭模型|关掉模型|模型状态|什么模型|引擎状态|怎么装模型/, mood: 'idle',
      fn: function (mm) {
        var q = String((mm && mm[0]) || '');
        if (/关闭模型|关掉模型/.test(q)) {
          alaSetCfg({ enabled: false });
          return '行，模型先挂起，我改用极速模式——快是快，就是话少。说「开启模型」能把我接回来。';
        }
        if (/开启模型|打开模型/.test(q)) {
          alaSetCfg({ enabled: true });
          return '好，正在连模型……状态条亮成 🧠 就是接上了。\n三个来源任选（设置页「阿刺引擎」）：LongCat（美团长猫，longcat.chat）——注册账号每日 10 万免费 token；本机 Qwen3-4B——装 Ollama 后 pull qwen3:4b；自定义模型——填任意 Ollama/OpenAI 兼容地址。\n也可以手动选极速模式。';
        }
        if (/怎么装模型|什么模型/.test(q)) {
          return '我能答本机数据，也能接模型（设置页四选）：① LongCat（美团长猫）——longcat.chat 开放平台注册，每日 10 万免费 token，填 API Key 就能用；② 本机 Qwen3-4B——ollama.com 装 Ollama → ollama pull qwen3:4b；③ 自定义模型——填任意 Ollama/OpenAI 兼容地址；④ 极速模式——最快，不联网。\n不管哪档，我都只说本机数据，答不了就直说不知道，不编。';
        }
        return alaReadyLine();
      } },
    { k: 'aciwater', re: /浇水|浇水吗| watering|给阿刺浇水|战术注入/, mood: 'happy',
      fn: function () {
        switchAciTab('grow');
        aciDo('water').then(function (r) { if (r && r.ok) refreshAciGrow(); });
        return '浇水要花 100 积分换成协作能量——我先把养成面板叫出来，你自己点「浇水」。放心，不浇我只会嘴毒，不会枯萎。';
      } },
    { k: 'acipk', re: /^PK$|发起PK|约战|竞技场|挑战券|挑战赛|对战谁/, mood: 'smirk',
      fn: function () {
        switchAciTab('pk');
        return '竞技场给你叫出来了。挑战券得用积分换（一张 = 完成 5 条计划的量），每次发起消耗 1 张；也能发到自习房或军团频道约人。战友制，不设全服榜。';
      } },
    { k: 'acistat', re: /查看属性|我的属性|阿刺属性|阿刺等级|我现在什么段位|综合战力/, mood: 'idle',
      fn: function () {
        switchAciTab('grow');
        return '养成面板开着呢——等级、能量、战力、段位都在上面，我这儿只读本机数据，不给自己加特效。';
      } },
    { k: 'default', re: /.*/, mood: 'smirk',
      fn: function (m, ctx) {
        mem.chats = (mem.chats || 0) + 1;
        saveMem();
        /* 模型不可用时，别用"这句话我看不懂"把人打发了：
         *   问"怎么做/为什么/是什么"的，先翻常识库给点能用的；
         *   翻不到也要问清场景，而不是装死。 */
        var q0 = String((ctx && ctx.text) || '');
        if (/怎么|如何|为什么|是什么|啥意思|什么意思|区别|该不该|要不要|能不能|有没有|哪年|什么时候/.test(q0)) {
          var tips = '';
          try { if (window.AlaTips && window.AlaTips.pick) tips = window.AlaTips.pick(q0, { budget: 200 }); } catch (e) {}
          if (tips) {
            return pick(['我不讲大道理，先给你能立刻用的：', '大方向是这样，具体的还得看你的情况：'])
              + '\n' + tips.replace(/^【[^】]*】[^\n]*\n?/, '').replace(/^· \[[^\]]+\] /gm, '· ');
          }
          return pick([
            '这个我得知道具体场景才敢说。你把情况补一句，比如"卡在开头""没时间""坚持三天就断"，我就给你拆。',
            '说细一点我才能给准的：现在卡的到底是"不知道从哪儿开始"，还是"知道怎么做但动不了"？'
          ]);
        }
        var base = pick([
          '这句话我看不懂，但我知道你想表达点什么。说点我能干的：问进度、问积分、问连击，或者直接说你今天打算干几件。',
          '这段我没接住。\n能聊的都在:进度 / 积分 / 连击 / 计划 / 军团 / 累了想摆烂 / 打开某页。',
          '听不太懂。不过不管你想聊什么，今天的计划清完了吗？先答这个。'
        ]);
        /* 原有 AI（闲聊雷达）顺嘴评一句：只提醒不扣分，扣分只在自习房开麦时算 */
        try {
          if (window.AIChat && typeof AIChat.classify === 'function' && AIChat.ready()) {
            AIChat.classify(String((ctx && ctx.text) || '')).then(function (r) {
              if (r && r.label === 'fish' && Number(r.p) >= 0.8) {
                pushMsg('bud', '顺嘴一提：闲聊雷达说这句话像摸鱼（置信度 ' + Math.round(r.p * 100) + '%）。\n这里只提醒不扣分——真扣分是在自习房开麦聊闲天的时候。');
              }
            }).catch(function () {});
          }
        } catch (e) {}
        return base;
      } },
  ];

  /* 查表原始答案：可供主路径与模型回退路径共用 */
  function tableOut(rule, m, ctx) {
    try {
      return typeof rule.fn === 'function' ? rule.fn(m, ctx) : (Array.isArray(rule.say) ? pick(rule.say) : String(rule.say || '…'));
    } catch (e) { return '（内部处理出了点岔子，但我的毒舌没受影响）'; }
  }

  function ruleByKey(k) {
    for (var i = 0; i < BRAIN.length; i++) if (BRAIN[i].k === k) return BRAIN[i];
    return null;
  }

  function answer(text) {
    text = String(text || '').trim();
    if (!text) return;
    pushMsg('me', text);
    /* 有一批动作在等守护密码：先认「密码 xxx」和「取消」 */
    if (pendingAct) {
      var pw = /^密码[\s:：]*(\S+)$/.exec(text);
      if (pw) { resumeWithPassword(pw[1]); return; }
      if (/^(取消|算了|不办了|作废)$/.test(text)) {
        pendingAct = null;
        pushMsg('sys', '动作已作废，什么都没动。');
        return;
      }
    }
    if (quiet && !/醒醒|回来|说话/.test(text)) {
      pushMsg('bud', '（安静模式中……说「醒醒」能把我叫回来）');
      return;
    }
    /* 表情/动作指令：摇一摇、跳一跳、生个气、笑一个、吃个惊、左转右转……
     * 认出来就当场演，不喂模型、不进上下文——这是逗它，不是问它问题。 */
    var fun = funIntent(text);
    if (fun) { funDo(fun); return; }
    var rule = null; var m = null;
    for (var i = 0; i < BRAIN.length; i++) {
      m = text.match(BRAIN[i].re);
      if (m) { rule = BRAIN[i]; break; }
    }
    if (!rule) rule = BRAIN[BRAIN.length - 1];
    var ctx = { text: text };
    /* 动手类（接消息 / 排计划 / 改计划）：走「模型提议 → 你点头 → 落地」那条路 */
    if (rule.act) { alaAct(rule.act, text); return; }
    /* 没点名"改计划"，但句子里就是「某条计划 + 改到几点 / 停用」→ 当场认出来，不打断成闲聊 */
    if (rule.k === 'default' && capOn('edit')) {
      var lb = tryLocalEdit(text);
      if (lb.actions.length || lb.why === 'off') return;
      if (lb.why === 'nointent') { pushMsg('bud', editAskBack(lb.plan)); return; }
    }
    /* 查表答不上来的，先喂给模型，别用一句固定话术把用户打发了：
     *   · nodata（天气/新闻/汇率…本机没有的外部事实）
     *   · default（听不懂的）
     * 接了模型就交给模型；模型答不了它自己会说不知道，比查表硬回体面。
     * 纯查表 / 模型没接上时，仍然用查表话术兜住，不空着。 */
    if (rule.k === 'nodata' && ((alaMode() !== 'table' && alaRuntimeCfg().enabled !== false && alaReady && alaReady.ok) || (netOn() && netWorth(text)))) {
      alaReply(text, rule, m, ctx);
      return;
    }
    /* 混合路由：查表接不住的（default）和代笔类（draft）→ 本地模型，模型不可用回退查表 */
    if ((rule.k === 'default' || rule.k === 'draft') && alaReady && alaReady.ok && alaRuntimeCfg().enabled !== false) {
      alaReply(text, rule, m, ctx);
      return;
    }
    var out = tableOut(rule, m, ctx);
    /* 略微延迟 + 说话动画，像在想怎么毒你 */
    setMood(listening ? 'listen' : (rule.mood || 'idle'), rule.k === 'mute' ? 0 : 5200);
    talking(true);
    setTimeout(function () {
      talking(false);
      pushMsg('bud', out, { q: text });
      if (rule.k === 'mute') quiet = true;
      if (rule.k === 'wake') quiet = false;
    }, 420 + Math.min(900, String(out).length * 12));
  }

  /* ---------------- 消息区 ---------------- */

  var msgsEl = null;

  /* 删单条：鼠标移上去每条右上角有个小 ×。
   * 删的时候顺手把它那一轮从上下文里摘掉——不然屏幕上看不见了，模型还记得。 */
  function deleteItem(item) {
    if (!item || !item.parentNode) return;
    var bub = item.querySelector('.pqb-m.bud') || item.querySelector('.pqb-m.me');
    var txt = bub ? String(bub.textContent || '') : '';
    var isMe = !!(bub && bub.classList.contains('me'));
    if (isMe) {
      dropHist(txt);
    } else {
      var q = item.getAttribute('data-q') || '';
      if (q) dropHist(q);
      else if (txt) {
        for (var i = alaHist.length - 1; i >= 0; i--) {
          if (alaHist[i] && alaHist[i].role === 'assistant' && alaHist[i].content === txt) {
            alaHist.splice(i, i > 0 && alaHist[i - 1].role === 'user' ? 2 : 1);
            break;
          }
        }
      }
    }
    item.parentNode.removeChild(item);
  }

  /* 清空对话记录：只清屏幕和上下文，计划和打卡一分不动。
   * 评价记录、roasts 计数这类"历史积累"也留着——清的是对话，不是你的账。 */
  function clearChat() {
    alaHist = [];
    try { quiet = false; } catch (e) {}
    if (msgsEl) {
      msgsEl.innerHTML = '';
      pushMsg('sys', '对话记录清掉了（计划和打卡一分没动）。');
    }
  }

  /* 联网搜到的来源：给能点的链接，不是一个只能看的字符串。
   * 只放行 http/https（javascript:、file: 一律丢），桌面版交主进程用系统浏览器打开，
   * 网页版就在新标签页开。 */
  function openLink(u) {
    var url = String(u || '');
    if (!/^https?:\/\//i.test(url)) return;
    var api = window.api;
    if (api && typeof api.openExternal === 'function') {
      try { api.openExternal(url); return; } catch (e) {}
    }
    try { window.open(url, '_blank', 'noopener'); } catch (e) {}
  }

  function pushLinks(web) {
    if (!msgsEl || !web || !web.results || !web.results.length) return null;
    var box = document.createElement('div');
    box.className = 'pqb-m sys pqb-links';
    var hd = document.createElement('div');
    hd.className = 'pqb-links-hd';
    hd.textContent = '参考（' + (web.via || '网络') + '）· 点标题直接打开，自己核一眼：';
    box.appendChild(hd);
    var seen = {};
    web.results.slice(0, 3).forEach(function (x, i) {
      var u = String((x && x.url) || '');
      if (!/^https?:\/\//i.test(u) || seen[u]) return;
      seen[u] = 1;
      var a = document.createElement('a');
      a.className = 'pqb-link';
      a.href = u;
      a.rel = 'noopener noreferrer';
      a.title = u;
      a.textContent = (i + 1) + '. ' + String((x && x.title) || u).slice(0, 60);
      a.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openLink(u);
      });
      box.appendChild(a);
    });
    if (box.children.length < 2) return null;
    msgsEl.appendChild(box);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return box;
  }

  function pushMsg(who, text, opts) {
    if (!msgsEl) return null;
    var item = makeItem(who, String(text == null ? '' : text), opts);
    msgsEl.appendChild(item);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    /* 自动朗读只念阿刺自己说的话；点哪段念哪段是另一条路（见 fillMsg） */
    if (who === 'bud' && ttsOn() && !listening) speak(text);
    return item;
  }

  /* 一条消息 = 外层（item）+ 气泡（pqb-m）+ 底下一排动作（只有阿刺的话才有）。
   * 包一层的理由：动作条不能塞进气泡里，否则 textContent / 复制 / 测试断言全被污染。 */
  function makeItem(who, text, opts) {
    var item = document.createElement('div');
    item.className = 'pqb-item ' + who;
    var bubble = document.createElement('div');
    bubble.className = 'pqb-m ' + who;
    fillMsg(bubble, text);
    item.appendChild(bubble);
    if (who === 'bud') {
      var q = opts && typeof opts.q === 'string' && opts.q ? opts.q : null;
      if (q) item.setAttribute('data-q', q);
      item.appendChild(toolsBar(text, q, item, bubble));
    } else if (who === 'me') {
      /* 自己说的话也能复制——想重发、想引用，不用手抄 */
      var mbar = document.createElement('div');
      mbar.className = 'pqb-tools';
      var cbtn = document.createElement('button');
      cbtn.type = 'button';
      cbtn.className = 'pqb-tool';
      cbtn.textContent = '复制';
      cbtn.title = '复制我说过的这句';
      cbtn.addEventListener('click', function (e) { e.stopPropagation(); copyText(text); });
      mbar.appendChild(cbtn);
      item.appendChild(mbar);
    }
    /* 每条都能单独删（自己的话、阿刺的回答、系统提示都算） */
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'pqb-del';
    del.title = '删掉这条（只删屏幕上这条和它的上下文）';
    del.textContent = '×';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      deleteItem(item);
    });
    item.appendChild(del);
    return item;
  }

  /* ---------------- 每条回答底下那排小动作 ----------------
   * 朗读：和点段落一样走 MeloTTS / 系统语音；
   * 复制：整段原文进剪贴板，粘贴出去不用手抄；
   * 重新回答：只有"因为某句话而答的"才有资格重来（重放那句），
   *           提示语、动手回执、催办这种没有对应问题，就不给这个按钮；
   * 评价：好/不好都记在本机（pq-ala-rate-v1），不传出去，以后自训练用得上。 */

  var RATE_KEY = 'pq-ala-rate-v1';

  function loadRate() {
    try { var a = JSON.parse(localStorage.getItem(RATE_KEY)); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function saveRate(list) {
    /* 不设人为上限：评价只写本机 localStorage，占的是你自己的磁盘，不是服务器。
     * 只有本机存储真写爆了（QuotaExceeded）才退让，留最近 2000 条继续记——
     * 每天评 5 条也得一年才碰得到这个水位。 */
    try {
      localStorage.setItem(RATE_KEY, JSON.stringify(list));
    } catch (e) {
      try { localStorage.setItem(RATE_KEY, JSON.stringify(list.slice(-2000))); } catch (e2) {}
    }
  }

  function copyText(t) {
    function done(ok) { pushMsg('sys', ok ? '复制好了。' : '复制没成功（这机器不让用剪贴板），你手动选一下。'); }
    var api = window.api;
    /* 桌面版走主进程剪贴板：file:// 下 navigator.clipboard 经常被拒，还会挑用户手势 */
    if (api && typeof api.clipboardWrite === 'function') {
      Promise.resolve(api.clipboardWrite(t)).then(function (r) {
        done(!!(r && r.ok) || legacyCopy(t));
      }, function () { done(legacyCopy(t)); });
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(function () { done(true); }, function () { done(legacyCopy(t)); });
        return;
      }
    } catch (e) {}
    done(legacyCopy(t));
  }
  function legacyCopy(t) {
    try {
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function canAskModel() {
    if (!window.AlaLLM) return false;
    if (alaMode() === 'table') return false;
    var cfg = alaRuntimeCfg();
    if (cfg.enabled === false) return false;
    return !!(alaReady && alaReady.ok);
  }

  /* 重新回答：拿原问题再问一遍，换掉这一条（历史里不留两份） */
  /* 重答 = 让模型重新生成（不是换个搜索词、也不是重放同一条 prompt）。
   * 做法：把上一版一起递过去，明确要求换个说法/换角度，温度也调高一点，
   * 这样点一次是一次新的生成，而不是复读机。 */
  function alaRegen(text, prev) {
    var lib = window.AlaLLM;
    if (!lib) return Promise.resolve(null);
    var cfg = alaRuntimeCfg();
    if (cfg.enabled === false) return Promise.resolve(null);
    if (cfg.mode === 'custom' && !cfg.endpoint) return Promise.resolve(null);
    if (cfg.mode === 'meituan' && !cfg.apiKey) return Promise.resolve(null);
    var extra = prev
      ? '\n\n【上一版回答（这次重写：换个说法、换个开头、别复读它）】\n' + String(prev).slice(0, 300)
      : '';
    var facts = alaFacts({ text: text }) + extra;
    var msgs = lib.buildMessages(text, facts, []);
    var opts = { temperature: 0.95, maxTokens: 600, maxChars: 600 };
    return new Promise(function (resolve) {
      function done(r) { resolve(r && r.text ? String(r.text) : null); }
      if (window.api && typeof window.api.alaAsk === 'function') {
        window.api.alaAsk({ cfg: cfg, messages: msgs, opts: opts }).then(done, function () { resolve(null); });
      } else {
        lib.ask(cfg, msgs, lib.fetchTransport(), opts).then(done, function () { resolve(null); });
      }
    });
  }

  function reAnswer(item, q) {
    if (!q) return;
    if (!canAskModel()) {
      pushMsg('sys', '重答要模型重新写一遍，现在没接上——设置页「阿刺引擎」接一个就能重来。');
      return;
    }
    var prev = item ? String((item.querySelector('.pqb-m.bud') || {}).textContent || '') : '';
    pushMsg('sys', '让它重新想一遍…');
    alaRegen(q, prev).then(function (txt) {
      if (!txt) { pushMsg('sys', '这次没想出来，等下再试。'); return; }
      var fresh = makeItem('bud', txt, { q: q });
      if (item && item.parentNode) item.parentNode.replaceChild(fresh, item);
      if (ttsOn() && !listening) speak(txt);
    });
  }

  function toolsBar(text, q, item, bubble) {
    var bar = document.createElement('div');
    bar.className = 'pqb-tools';
    function btn(icon, title, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pqb-tool';
      b.textContent = icon;
      b.title = title;
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        fn(b);
      });
      bar.appendChild(b);
      return b;
    }
    btn('朗读', '朗读这一段', function () { speakSeg(text, bubble); });
    btn('复制', '复制这一段原文', function () { copyText(text); });
    if (q) btn('重答', '重新回答（重放：' + String(q).slice(0, 20) + '）', function () { reAnswer(item, q); });
    btn('评价', '给这段回答打分', function (b) { rateAsk(bar, text, q); b.blur(); });
    return bar;
  }

  function rateAsk(bar, text, q) {
    bar.innerHTML = '';
    function tag(t) {
      var s = document.createElement('span');
      s.className = 'pqb-rated';
      s.textContent = t;
      bar.appendChild(s);
    }
    function pick2(icon, title, r, label) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pqb-tool';
      b.textContent = icon;
      b.title = title;
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var list = loadRate();
        list.push({ at: Date.now(), r: r, q: String(q || '').slice(0, 120), a: String(text || '').slice(0, 300) });
        saveRate(list);
        bar.innerHTML = '';
        tag(label);
      });
      bar.appendChild(b);
    }
    tag('这条怎么样？');
    pick2('有用', '说得对，留着', 'up', '已记下：有用');
    pick2('没用', '说错了 / 没帮上', 'down', '已记下：没用');
  }

  /* 一条消息=可点的几段：有换行就拆开，每段单独点单独念。
   * 段与段之间补回 '\n' 文本节点，所以整块的 textContent 跟原来一字不差
   * （复制、测试断言都不受影响），pre-wrap 也照旧换行。 */
  function fillMsg(box, text) {
    var parts = text.split('\n');
    if (parts.length < 2) {
      box.textContent = text;
      if (!text.trim()) return;
      box.classList.add('readable');
      box.title = '点一下念这段';
      box.addEventListener('click', function () { speakSeg(text, box); });
      return;
    }
    for (var i = 0; i < parts.length; i++) {
      if (i) box.appendChild(document.createTextNode('\n'));
      if (!parts[i].trim()) continue;
      var sp = document.createElement('span');
      sp.className = 'pqb-seg';
      sp.textContent = parts[i];
      sp.title = '点一下念这段';
      (function (t, el) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          speakSeg(t, el);
        });
      })(parts[i], sp);
      box.appendChild(sp);
    }
  }

  /* ---------------- 语音（复用 VoiceASR，本地识别） ---------------- */

  async function toggleMic() {
    var mic = document.getElementById('pqb-mic');
    if (!mic) return;
    stopSpeak();   /* 要听你说话了，先把自己嘴闭上，免得回声 */
    if (listening) {
      try { if (window.VoiceASR) VoiceASR.detach(); } catch (e) {}
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      listening = false;
      mic.classList.remove('on');
      mic.textContent = '🎤';
      pushMsg('sys', '语音已关');
      setMood('idle', 1500);
      return;
    }
    if (!window.VoiceASR) { pushMsg('sys', '这台设备没有语音识别能力'); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      pushMsg('sys', '拿不到麦克风（权限被拒或没有麦克风）');
      return;
    }
    pushMsg('sys', '阿刺在戴耳机……首次要加载本地语音模型（约 42MB，只这一次）');
    mic.classList.add('on');
    mic.textContent = '⏳';
    try {
      var ok = await VoiceASR.attach(stream, function (t) {
        /* 听写出来先落到输入框，不直接发：说错一个字、识别跑偏，都还来得及改 */
        var box = document.getElementById('pqb-text');
        var clean = String(t || '').trim();
        if (!clean) return;
        if (box) {
          box.value = box.value ? (box.value.replace(/\s+$/, '') + ' ' + clean) : clean;
          try {
            box.focus();
            box.setSelectionRange(box.value.length, box.value.length);
          } catch (e) {}
        }
        pushMsg('sys', '听写好了：「' + clean + '」——先放在输入框里，改完按「发」或回车我才发。');
        setMood('listen', 0);
      });
      if (!ok) throw new Error('attach failed');
      listening = true;
      mic.textContent = '🎙';
      pushMsg('sys', '在听了。说出来会写到下面的输入框，你确认了再发。语音在本机转文字，不出设备。');
      setMood('listen', 0);
    } catch (e) {
      mic.classList.remove('on');
      mic.textContent = '🎤';
      pushMsg('sys', '语音识别没起来：' + (e && e.message ? e.message : '未知错误'));
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    }
  }

  /* ---------------- 面板与浮标 ---------------- */

  /* ---------------- 战友养成 / 竞技场（aci） ----------------
   * 数据来自主进程 window.api.aciState / aciAction；纯查表兜底不依赖模型。 */
  var aciCache = null;
  function switchAciTab(name) {
    var panel = document.getElementById('pqb-panel');
    if (!panel) return;
    setOpen(true);
    panel.querySelectorAll('#pqb-tabs button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-view') === name); });
    ['chat', 'grow', 'pk'].forEach(function (v) {
      var el = panel.querySelector('#pqb-view-' + v);
      if (el) el.classList.toggle('on', v === name);
    });
    if (name === 'grow') refreshAciGrow();
    if (name === 'pk') refreshAciPk();
  }
  function aciApi() { return (typeof window !== 'undefined' && window.api) ? window.api : null; }
  function escA(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  async function aciFetch() {
    var api = aciApi();
    if (!api || typeof api.aciState !== 'function') return null;
    try { var r = await api.aciState(); return (r && r.aci) ? r : null; } catch (e) { return null; }
  }
  async function aciDo(action, payload) {
    var api = aciApi();
    if (!api || typeof api.aciAction !== 'function') { pushMsg('sys', '阿刺养成只在桌面版可用'); return null; }
    try {
      var r = await api.aciAction(action, payload || {});
      if (r && r.broadcast && r.broadcast.venue === 'room' && api.aciRoomSay) {
        // 自习房有 🤖 旁路：由主进程转发，不算刷屏
        try { await api.aciRoomSay(r.broadcast.text); } catch (e) {}
      } else if (r && r.broadcast && r.broadcast.venue === 'legion') {
        pushMsg('sys', '挑战文案已生成，请复制到军团频道发布（避免绕过发言规则）：\n' + r.broadcast.text);
      }
      if (r && r.message) pushMsg('bud', r.message);
      return r;
    } catch (e) { pushMsg('sys', '操作失败：' + ((e && e.message) || e)); return null; }
  }
  async function refreshAciGrow() {
    var box = document.getElementById('pqb-view-grow');
    if (!box) return;
    var d = await aciFetch();
    if (!d) { box.innerHTML = '<div class="pqb-card pqb-muted">桌面版才能查看养成数据。</div>'; return; }
    aciCache = d;
    var a = d.aci, r = d.rules || {}, dv = d.derived || {};
    var need = dv.expNeeded || ((a.level + 1) * (r.EXP_PER_LEVEL || 10));
    var pct = Math.min(100, Math.round((a.exp || 0) / need * 100));
    var Sup = (r.__supplies || []);
    var suppliesHtml = '';
    // 补给清单：优先用主进程下发的 SUPPLIES，兜底内置
    var sup = d.supplies || [
      { id: 'deepAnalysis', name: '深度分析', desc: '历史数据挖掘、趋势报告', energy: 1 },
      { id: 'replyForMe', name: '代回消息', desc: '好友区/军团代拟并发送回复', energy: 2 },
      { id: 'pkTactics', name: 'PK 战术建议', desc: '针对对手的策略', energy: 1 },
      { id: 'defyGuard', name: '抗命担保', desc: '替你扛一次不合理命令', energy: 3 },
      { id: 'forceReview', name: '强制复盘', desc: '连续低完成率时弹窗复盘', energy: 1 },
    ];
    sup.forEach(function (s) {
      var got = (a.supplies && a.supplies[s.id]) || 0;
      suppliesHtml += '<div class="pqb-supply"><span><b>' + escA(s.name) + '</b> <span class="pqb-muted">' + escA(s.desc) + '</span></span>'
        + '<span>' + (got ? '<span class="pqb-tag">已解锁×' + got + '</span> ' : '')
        + '<button class="pqb-btn" data-sup="' + escA(s.id) + '" ' + ((a.energy || 0) < s.energy ? 'disabled' : '') + '>' + s.energy + '能量</button></span></div>';
    });
    box.innerHTML = ''
      + '<div class="pqb-card"><h4>🌵 阿刺 · 战友 <span class="pqb-tag">' + escA(dv.tierName || '新芽段') + '</span></h4>'
      + '  <div class="pqb-kv"><span>等级</span><b>Lv.' + (a.level || 1) + ' / ' + (r.MAX_LEVEL || 100) + '</b></div>'
      + '  <div class="pqb-bar"><i style="width:' + pct + '%"></i></div>'
      + '  <div class="pqb-kv"><span>经验</span><b>' + (a.exp || 0) + ' / ' + need + '</b></div>'
      + '  <div class="pqb-kv"><span>协作能量</span><b>' + (a.energy || 0) + '</b></div>'
      + '  <div class="pqb-kv"><span>浇水次数</span><b>' + (a.waterCount || 0) + '</b></div>'
      + '  <div class="pqb-kv"><span>本周完成率</span><b>' + (dv.weekRate || 0) + '%</b></div>'
      + '  <div class="pqb-kv"><span>综合战力</span><b>' + (dv.power || 0) + '</b></div>'
      + '  <div class="pqb-row"><button class="pqb-btn go" id="pqb-water">💧 浇水（' + (r.POINTS_PER_ENERGY || 100) + ' 积分）</button>'
      + '  <button class="pqb-btn" id="pqb-buyticket">🎫 换挑战券（' + (dv.ticketPrice || 50) + ' 积分）</button></div>'
      + '  <div class="pqb-muted" style="margin-top:6px">浇水 = 战术注入，解锁强化态；不浇水只停止成长，阿刺永远不会枯萎。基础功能（查表/毒舌/排计划）一直免费。</div>'
      + '</div>'
      + '<div class="pqb-card"><h4>⚡ 强化态补给</h4>' + suppliesHtml + '</div>'
      + '<div class="pqb-card"><h4>🤝 战友特权</h4>'
      + '  <div class="pqb-kv"><span>失望模式</span><b>' + ((a.privileges && a.privileges.disappointment && a.privileges.disappointment.enabled) ? '开' : '关') + '</b></div>'
      + '  <div class="pqb-kv"><span>代扣分（已用 ' + ((a.privileges && a.privileges.deductGuard && a.privileges.deductGuard.charges) || 0) + ' 次）</span>'
      + '  <button class="pqb-btn" data-priv="guardDeduct">代扣</button></div>'
      + '  <div class="pqb-kv"><span>信用担保</span>'
      + '  <button class="pqb-btn" data-priv="guarantee">' + (((a.privileges && a.privileges.creditGuarantee && a.privileges.creditGuarantee.active)) ? '关闭' : '开启') + '</button></div>'
      + '</div>';
    var w = box.querySelector('#pqb-water'); if (w) w.onclick = function () { aciDo('water').then(function (r) { if (r && r.ok) refreshAciGrow(); }); };
    var bt = box.querySelector('#pqb-buyticket'); if (bt) bt.onclick = function () { aciDo('buyTicket').then(function (r) { if (r && r.ok) { refreshAciGrow(); refreshAciPk(); } }); };
    box.querySelectorAll('[data-sup]').forEach(function (b) {
      b.onclick = function () { aciDo('useSupply', { supplyId: b.getAttribute('data-sup') }).then(function (r) { if (r && r.ok) refreshAciGrow(); }); };
    });
    box.querySelectorAll('[data-priv]').forEach(function (b) {
      b.onclick = function () {
        var p = b.getAttribute('data-priv');
        if (p === 'guardDeduct') aciDo('guardDeduct').then(function (r) { if (r && r.ok) refreshAciGrow(); });
        else if (p === 'guarantee') {
          var on = !((a.privileges && a.privileges.creditGuarantee && a.privileges.creditGuarantee.active));
          aciDo('toggleGuarantee', { on: on }).then(function (r) { if (r && r.ok) refreshAciGrow(); });
        }
      };
    });
  }
  async function refreshAciPk() {
    var box = document.getElementById('pqb-view-pk');
    if (!box) return;
    var d = await aciFetch();
    if (!d) { box.innerHTML = '<div class="pqb-card pqb-muted">桌面版才能查看竞技场。</div>'; return; }
    aciCache = d;
    var a = d.aci, r = d.rules || {}, dv = d.derived || {};
    var tix = a.tickets || 0;
    var cooling = dv.cooling, hidden = dv.hidden;
    var matches = (a.pk && a.pk.matches) || [];
    var stats = (a.pk && a.pk.stats) || {};
    var matchHtml = matches.slice(0, 5).map(function (m) {
      var vtxt = { local: '本地', room: '自习房', legion: '军团' }[m.venue] || m.venue;
      return '<div class="pqb-kv"><span>' + escA(vtxt) + ' · ' + m.durationDays + '天 · ' + escA(m.state) + '</span>'
        + (m.state === 'pending' || m.state === 'matching'
          ? '<button class="pqb-btn" data-accept="' + escA(m.id) + '">应战</button>'
          : '<b>' + escA(m.result || '—') + '</b>') + '</div>';
    }).join('') || '<div class="pqb-muted">还没有挑战记录。</div>';
    box.innerHTML = ''
      + '<div class="pqb-card"><h4>🎫 挑战券 <span class="pqb-tag">' + tix + ' / ' + (r.MAX_TICKETS || 3) + '</span></h4>'
      + '  <div class="pqb-kv"><span>段位</span><b>' + escA(dv.tierName || '新芽段') + '</b></div>'
      + '  <div class="pqb-kv"><span>综合战力</span><b>' + (dv.power || 0) + '</b></div>'
      + '  <div class="pqb-kv"><span>今日发起 / 应战</span><b>' + (a.pk ? a.pk.initiateToday : 0) + ' / ' + (a.pk ? a.pk.acceptToday : 0) + '</b></div>'
      + '  <div class="pqb-kv"><span>状态</span><b>' + (cooling ? '冷却中' : hidden ? '隐身中' : '可战') + '</b></div>'
      + '  <div class="pqb-muted" style="margin:6px 0">战友制：券用积分换，每次消耗 1 张。发起每日 1 次、应战每日 2 次；同对手 48h 冷却；赛后 12h 冷却（可用 1 张券解除）。胜负 = 完成率×70% + 阿刺等级×30%。无全服榜，只看战绩。</div>'
      + '  <div class="pqb-row"><button class="pqb-btn go" id="pqb-pk-local">⚔ 发起（本地）</button>'
      + '  <button class="pqb-btn" id="pqb-pk-room">发到自习房</button>'
      + '  <button class="pqb-btn" id="pqb-pk-legion">发到军团</button></div>'
      + '  <div class="pqb-row"><label class="pqb-muted">时长 <select id="pqb-pk-days"><option value="1">1天</option><option value="3" selected>3天</option><option value="7">1周</option></select></label>'
      + '  <button class="pqb-btn" id="pqb-pk-hidden">' + (hidden ? '退出隐身' : '隐身24h') + '</button>'
      + (cooling ? '<button class="pqb-btn" id="pqb-pk-skip">用券解冷却</button>' : '') + '</div>'
      + '</div>'
      + '<div class="pqb-card"><h4>📜 战绩 <span class="pqb-muted">' + (stats.wins || 0) + '胜 ' + (stats.draws || 0) + '平 ' + (stats.losses || 0) + '负</span></h4>'
      + matchHtml + '</div>';
    function days() { var s = box.querySelector('#pqb-pk-days'); return s ? Number(s.value) : 3; }
    var mk = function (venue) { return function () { aciDo('createChallenge', { venue: venue, durationDays: days() }).then(function (r) { if (r && r.ok) refreshAciPk(); }); }; };
    var bl = box.querySelector('#pqb-pk-local'); if (bl) bl.onclick = mk('local');
    var br = box.querySelector('#pqb-pk-room'); if (br) br.onclick = mk('room');
    var bg = box.querySelector('#pqb-pk-legion'); if (bg) bg.onclick = mk('legion');
    var bh = box.querySelector('#pqb-pk-hidden'); if (bh) bh.onclick = function () { aciDo('setHidden', { hidden: !hidden }).then(function (r) { if (r && r.ok) refreshAciPk(); }); };
    var bs = box.querySelector('#pqb-pk-skip'); if (bs) bs.onclick = function () { aciDo('skipCooldown').then(function (r) { if (r && r.ok) refreshAciPk(); }); };
    box.querySelectorAll('[data-accept]').forEach(function (b) {
      b.onclick = function () { aciDo('acceptChallenge', { matchId: b.getAttribute('data-accept') }).then(function (r) { if (r && r.ok) refreshAciPk(); }); };
    });
  }

  function buildUI() {
    injectStyle();
    loadMem();
    var fab = document.createElement('div');
    fab.id = 'pqb-fab';
    fab.title = '阿刺 Pro · 点我聊两句（按住可拖到任意位置）';
    fab.innerHTML = cactusDOM('fab') + '<div class="pqb-badge">!</div>';
    document.body.appendChild(fab);

    /* 圆形浮标：可拖到软件任意位置，位置会记住（拖动超过 6px 算拖动，不弹面板） */
    var fabDragMoved = false;
    function applyFabPos(x, y) {
      var w = fab.offsetWidth || 58, h = fab.offsetHeight || 58;
      x = Math.max(6, Math.min(window.innerWidth - w - 6, x));
      y = Math.max(6, Math.min(window.innerHeight - h - 6, y));
      fab.style.left = x + 'px';
      fab.style.top = y + 'px';
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
      mem.fx = x;
      mem.fy = y;
    }
    if (typeof mem.fx === 'number' && typeof mem.fy === 'number') applyFabPos(mem.fx, mem.fy);
    ['mousedown', 'touchstart'].forEach(function (ev) {
      fab.addEventListener(ev, function (e) {
        if (e.button && e.button !== 0) return;
        var pt = e.touches ? e.touches[0] : e;
        var sx = pt.clientX, sy = pt.clientY;
        var ox = fab.offsetLeft, oy = fab.offsetTop;
        fabDragMoved = false;
        function move(ev) {
          var p2 = ev.touches ? ev.touches[0] : ev;
          var dx = p2.clientX - sx, dy = p2.clientY - sy;
          if (!fabDragMoved && Math.abs(dx) + Math.abs(dy) < 6) return;
          if (!fabDragMoved) { fabDragMoved = true; fab.classList.add('dragging'); }
          ev.preventDefault();
          applyFabPos(ox + dx, oy + dy);
        }
        function up() {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.removeEventListener('touchmove', move);
          document.removeEventListener('touchend', up);
          if (fabDragMoved) {
            saveMem();
            setTimeout(function () { fab.classList.remove('dragging'); }, 60);
          }
        }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend', up);
      }, { passive: false });
    });

    var panel = document.createElement('div');
    panel.id = 'pqb-panel';
    panel.innerHTML = ''
      + '<div id="pqb-head">'
      + '  <div style="flex:0 0 auto">' + cactusDOM('head') + '</div>'
      + '  <div class="pqb-tt"><b>阿刺 Pro</b><div class="pqb-sub" title="带路 · 汇报 · 毒舌 · 接消息 · 排计划 · 本地语音">带路 · 毒舌 · 会动手</div>'
      + '    <div class="pqb-sub-row">'
      + '      <div class="pqb-sub" id="pqb-aimode" title="引擎状态">⚡ 极速</div>'
      + '      <button id="pqb-ro" aria-label="只读模式" title="闭嘴别动手（只读）：阿刺只看不动。右键点浮标也能切">🖐</button>'
      + '      <button id="pqb-clear" aria-label="清空对话记录" title="清空对话记录（只清屏幕和上下文，计划和打卡不动）">清空</button>'
      + '      <button id="pqb-close" aria-label="收起">×</button>'
      + '    </div>'
      + '  </div>'
      + '</div>'
      + '<div id="pqb-tabs">'
      + '  <button data-view="chat" class="on">💬 聊天</button>'
      + '  <button data-view="grow">🌵 养成</button>'
      + '  <button data-view="pk">⚔ 竞技场</button>'
      + '</div>'
      + '<div id="pqb-view-chat" class="pqb-view on">'
      + '  <div id="pqb-msgs"></div>'
      + '  <div id="pqb-fun">想让它动？直接说：<b>摇一摇</b> · <b>跳一跳</b> · <b>生个气</b> · <b>笑一个</b> · <b>吃个惊</b> · <b>向左转</b></div>'
      + '  <div id="pqb-input">'
      + '    <input id="pqb-text" placeholder="说话，或者点右边麦克风…" maxlength="200" />'
      + '    <button id="pqb-send">发</button>'
      + '    <button id="pqb-mic" title="语音识别（本地）">🎤</button>'
      + '    <button id="pqb-speak" title="朗读：关（点一下让阿刺出声）">🔈</button>'
      + '  </div>'
      + '  <div id="pqb-hint">对话与数据全部本机生成，不联网；接上模型后，复杂些的问题也能聊。</div>'
      + '</div>'
      + '<div id="pqb-view-grow" class="pqb-view"></div>'
      + '<div id="pqb-view-pk" class="pqb-view"></div>';
    document.body.appendChild(panel);

    /* 真 3D：在画布上现场建模（浮标一个小场景，面板一个主场景） */
    if (window.PQBuddy3D) {
      try {
        gl3dFab = PQBuddy3D.create(fab.querySelector('canvas'), { compact: true });
        gl3d = PQBuddy3D.create(panel.querySelector('canvas'));
      } catch (e) { gl3d = gl3dFab = null; }
      if (gl3d) { gl3d.setMood(mood); gl3d.setRotY(rotY); gl3d.pause(); }
      if (gl3dFab) { gl3dFab.setMood(mood); gl3dFab.setRotY(rotY); }
      /* 没有 WebGL 时退回一个静态剪影，至少不空着 */
      if (!gl3d && !gl3dFab) {
        document.querySelectorAll('.pqb-stage').forEach(function (st) {
          st.innerHTML = '<div class="pqb-fallback">🌵</div>';
        });
      }
      /* 跟随软件明暗主题换配色 */
      var appEl = document.getElementById('app');
      if (appEl && window.MutationObserver) {
        new MutationObserver(function () {
          [gl3d, gl3dFab].forEach(function (g) { if (g) g.refreshTheme(); });
        }).observe(appEl, { attributes: true, attributeFilter: ['data-theme'] });
      }
    }

    msgsEl = panel.querySelector('#pqb-msgs');
    pushMsg('bud', '又见面了。我是阿刺 Pro——会听人话（点麦克风），头也能转（拖它）。\n'
      + '接上模型之后，我还能替你动手：看搭子和频道的消息帮你起草回复、把今天排成计划、指着你计划里的坑给改法。'
      + '每一条都得你点头我才动，绝不自己乱来。\n'
      + '老规矩：只讲本机数据，不编。');

    fab.addEventListener('click', function () {
      if (fabDragMoved) { fabDragMoved = false; return; } /* 刚拖完，不算点击 */
      /* 点开面板只展示已有的未读提醒（scold/nudge 早就 pushMsg 进了记录）。
         不要再伪造一句「我不太想动」当成用户说的 —— 那会让闲聊雷达对着
         程序自己编的话判摸鱼，再让阿刺顺嘴提醒，看着就像它自言自语。 */
      setOpen(!open);
    });

    panel.querySelector('#pqb-clear').addEventListener('click', function () { clearChat(); });
    panel.querySelector('#pqb-close').addEventListener('click', function () { setOpen(false); });

    /* 战友养成 / 竞技场 tab */
    panel.querySelectorAll('#pqb-tabs button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.getAttribute('data-view');
        panel.querySelectorAll('#pqb-tabs button').forEach(function (b) { b.classList.toggle('on', b === btn); });
        ['chat', 'grow', 'pk'].forEach(function (name) {
          var el = panel.querySelector('#pqb-view-' + name);
          if (el) el.classList.toggle('on', name === v);
        });
        if (v === 'grow') refreshAciGrow();
        if (v === 'pk') refreshAciPk();
      });
    });

    /* ---------------- 只读总开关的两个快入口 ----------------
     * 设置页藏在「设置 → 动手能力 → 最上面」，找三下才找到，用户嫌深。
     * 这里给两个一伸手就够得着的：面板头上一个按钮、浮标右键直接切。 */
    var roBtn = panel.querySelector('#pqb-ro');
    function paintRO() {
      if (!roBtn) return;
      var ro = alaReadOnly();
      roBtn.classList.toggle('on', ro);
      roBtn.textContent = ro ? '只看' : '🖐';
      roBtn.title = ro
        ? '现在只读：阿刺只看不动。点一下恢复原来的动手开关（右键点浮标也能切）'
        : '闭嘴别动手（只读）：阿刺只看不动，不排计划、不改计划、不发消息。右键点浮标也能切';
    }
    function toggleRO() {
      alaSetCaps({ ro: !alaReadOnly() });
      paintRO();
      var ro = alaReadOnly();
      pushMsg('sys', ro
        ? '行，我闭嘴了。接下来只看不动：不排计划、不改计划、不发消息，你问我照样答。\n想放我上手，点「只看」或者右键点浮标。'
        : '手放回来了，之前那几项开关按你原来的设置恢复。');
      if (typeof toast === 'function') toast(ro ? '只读模式：阿刺只看不动' : '已退出只读');
    }
    paintRO();
    roHook.paint = paintRO;
    roHook.toggle = toggleRO;
    if (roBtn) roBtn.addEventListener('click', toggleRO);
    /* 浮标右键：不开面板也能一把切，切完有短提示 */
    fab.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleRO();
    });

    var input = panel.querySelector('#pqb-text');
    var send = panel.querySelector('#pqb-send');
    function sendIt() {
      var v = input.value.trim();
      if (!v) return;
      input.value = '';
      answer(v);
    }
    send.addEventListener('click', sendIt);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendIt(); });
    panel.querySelector('#pqb-mic').addEventListener('click', toggleMic);
    panel.querySelector('#pqb-speak').addEventListener('click', toggleSpeak);
    updateTtsUI();

    /* 3D 拖动旋转（两个舞台同步） */
    ['mousedown', 'touchstart'].forEach(function (ev) {
      panel.querySelector('.pqb-stage').addEventListener(ev, startDrag, { passive: false });
    });
  }

  function startDrag(e) {
    e.preventDefault();
    var sx = (e.touches ? e.touches[0].clientX : e.clientX);
    var base = rotY;
    var stage = e.currentTarget;
    stage.style.cursor = 'grabbing';
    if (gl3d) { gl3d.startDrag(); gl3d.setRotY(rotY); }
    function move(ev) {
      var x = (ev.touches ? ev.touches[0].clientX : ev.clientX);
      rotY = Math.max(-80, Math.min(80, base + (x - sx) * 0.6));
      applyRot();
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', up);
      stage.style.cursor = 'grab';
      if (gl3d) gl3d.endDrag();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', up);
  }

  function applyRot() {
    if (gl3d) gl3d.setRotY(rotY);
    if (gl3dFab) gl3dFab.setRotY(rotY);
  }

  function setOpen(v) {
    open = !!v;
    var p = document.getElementById('pqb-panel');
    if (!p) return;
    p.classList.toggle('show', open);
    var badge = document.querySelector('#pqb-fab .pqb-badge');
    if (badge) badge.style.display = 'none';
    if (open) {
      positionPanel();
      roHook.paint();  /* 面板里的「只看」按钮要跟设置页同步 */
      var growV = document.getElementById('pqb-view-grow');
      var pkV = document.getElementById('pqb-view-pk');
      if (growV && growV.classList.contains('on')) refreshAciGrow();
      if (pkV && pkV.classList.contains('on')) refreshAciPk();
      var input = document.getElementById('pqb-text');
      if (input) setTimeout(function () { input.focus(); }, 120);
      if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
      /* 面板从 display:none 变可见后画布才有尺寸，这时补一次布局再开动画 */
      if (gl3d) setTimeout(function () { gl3d.resize(); gl3d.resume(); }, 40);
    } else if (gl3d) {
      gl3d.pause();
    }
  }

  /* 面板贴着浮标弹出：浮标被拖到哪，面板就跟到哪（出屏自动收回来） */
  function positionPanel() {
    var p = document.getElementById('pqb-panel');
    if (!p) return;
    var pw = p.offsetWidth || 334, ph = p.offsetHeight || 446;
    var fx = typeof mem.fx === 'number' ? mem.fx : 18;
    var fy = typeof mem.fy === 'number' ? mem.fy : (window.innerHeight - 76);
    var fw = 58;
    var left = Math.min(Math.max(8, fx + fw / 2 - pw / 2), Math.max(8, window.innerWidth - pw - 8));
    var top = fy - ph - 12;
    if (top < 8) top = Math.min(fy + fw + 12, Math.max(8, window.innerHeight - ph - 8));
    p.style.left = left + 'px';
    p.style.top = top + 'px';
    p.style.bottom = 'auto';
  }

  /* ---------------- 主动催办 ----------------
   * 用户要求「计划没完成是阿刺要催」：到点没打勾的、已经错过的，阿刺主动开口，
   * 而且要指名道姓说清是哪一条、欠了多久，不许只说"你还有任务没做"。
   * 节流（防止变成骚扰）：同一条每天最多催 2 次、间隔 ≥45 分钟；全天最多 6 条。 */

  var NAG_GAP = 45 * 60e3;
  var NAG_DAY_MAX = 6;
  var NAG_PER_PLAN = 2;

  function planMin(t) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  /* 到点了还没打勾的（按时间从早到晚） */
  function nagQueue() {
    var t = todayStats();
    var d = new Date();
    var cur = d.getHours() * 60 + d.getMinutes();
    var out = [];
    for (var i = 0; i < t.plans.length; i++) {
      var p = t.plans[i];
      if (!p || p.status === 'done' || p.when === 'boot') continue;
      var pm = planMin(p.time);
      if (pm == null || pm > cur) continue;       /* 还没到点，先不催 */
      out.push({ id: p.id || '', title: p.title || p.name || '那条计划', min: pm, late: cur - pm, missed: p.status === 'missed' });
    }
    out.sort(function (a, b) { return a.min - b.min; });
    return out;
  }

  function nagState() {
    var day = new Date().toDateString();
    if (!mem.nag || mem.nag.day !== day) mem.nag = { day: day, count: 0, items: {}, nudgeKey: '', nudgeStreak: 0, nudgeCount: 0 };
    return mem.nag;
  }

  function nagPick() {
    var st = nagState();
    if ((st.count || 0) >= NAG_DAY_MAX) return null;
    var q = nagQueue();
    for (var i = 0; i < q.length; i++) {
      var it = q[i];
      if (!it.id) continue;
      var rec = st.items[it.id] || { n: 0, at: 0 };
      if (rec.n >= NAG_PER_PLAN) continue;
      if (Date.now() - rec.at < NAG_GAP && rec.at) continue;
      return { it: it, rec: rec, st: st };
    }
    return null;
  }

  function nagText(it) {
    var mins = Math.max(1, Math.round(it.late));
    if (it.missed) {
      return '「' + it.title + '」已经错过了。别装看不见——要么现在补，要么把时间挪到你还活着的时候。';
    }
    if (mins < 60) {
      return '「' + it.title + '」到点 ' + mins + ' 分钟了，还没打勾。现在做，20 分钟能收尾；拖到半夜就只剩懊悔。';
    }
    return '「' + it.title + '」欠了 ' + Math.round(mins / 60) + ' 小时了。就它，现在，先做 5 分钟——做不完也比零点强。';
  }

  function nudgeNow() {
    if (quiet || listening) return null;
    var pick = nagPick();
    if (!pick) return null;
    var it = pick.it;
    var st = pick.st;
    st.count = (st.count || 0) + 1;
    st.items[it.id] = { n: pick.rec.n + 1, at: Date.now() };
    saveMem();
    pushMsg('bud', nagText(it) + '\n（不想现在做？说「把「' + it.title + '」改到 22:00」，我认；说「改成 5 分」，我也认。）');
    setMood('angry', 6000);
    var badge = document.querySelector('#pqb-fab .pqb-badge');
    if (badge && !open) badge.style.display = 'block';
    return it;
  }

  /* 原来的"整体停滞"提醒：没有任何到点未完成的，但连续两轮进度没动 */
  function nudgeStall() {
    if (quiet || listening) return;
    var t = todayStats();
    if (!t.total || t.left <= 0) return;
    var st = nagState();
    var key = t.done + '/' + t.total;
    if (st.nudgeKey === key) st.nudgeStreak = (st.nudgeStreak || 0) + 1;
    else { st.nudgeKey = key; st.nudgeStreak = 0; }
    if (st.nudgeStreak >= 2 && (st.nudgeCount || 0) < 3) {
      st.nudgeCount = (st.nudgeCount || 0) + 1;
      saveMem();
      var badge = document.querySelector('#pqb-fab .pqb-badge');
      if (badge && !open) badge.style.display = 'block';
      pushMsg('bud', CHEERS[Math.floor(Math.random() * CHEERS.length)] + '\n（今天还剩 ' + t.left + ' 项。这条是加油，不是催命——进度一动，我就不再念。）');
    }
  }

  function nudge() {
    var hit = nudgeNow();
    if (hit) return;
    nudgeStall();
  }

  /* ---------------- 启动 ---------------- */

  function start(opts) {
    if (typeof (opts && opts.getState) === 'function') getState = opts.getState;
    if (typeof (opts && opts.nav) === 'function') navFn = opts.nav;
    if (opts && opts.bridge && typeof opts.bridge === 'object') bridge = opts.bridge;
    if (document.getElementById('pqb-fab')) return;
    buildUI();
    alaProbeNow();   /* 探测外接模型，不可用就纯查表，不阻塞 UI */
    /* 主动催办：每 10 分钟扫一次，到点没打勾的就催（同一条每天最多 2 次，全天最多 6 条） */
    setInterval(nudge, 10 * 60e3);
    setTimeout(nudge, 90e3);
    /* 闲置时偶尔打个哈欠，证明活着 */
    setInterval(function () {
      if (!open || listening || quiet) return;
      if (Math.random() < 0.12) setMood(Math.random() < 0.5 ? 'smirk' : 'sleep', 2200);
    }, 12000);
    /* 加入自习室一起陪聊：每 4 分钟请主进程代发一句（它内部 3 分钟节流 +
     * 只在不 notInRoom 时发，查表文案离线可用），有队友时才开口。 */
    setInterval(function () {
      var api = aciApi();
      if (!api || typeof api.aciRoomSay !== 'function' || quiet) return;
      api.aciRoomSay().catch(function () {});
    }, 4 * 60e3);
  }

  window.PQBuddy = {
    start: start,
    answer: answer,
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    info: function () {
      return {
        open: open, listening: listening, roasts: mem.roasts || 0, name: mem.name || '',
        ala: alaReady, caps: alaCaps(), actReady: actReady(), tts: alaTtsCfg(), speaking: ttsSpeaking,
      };
    },
    scold: scold,
    /* 清掉毒舌节流（切换场景/自测时用，免得 2 分钟内同一类只响一次） */
    scoldReset: function () { scoldLast = {}; },
    /* 战友养成 / 竞技场：外部可主动唤起 tab（供设置页/快捷入口调用） */
    aci: {
      openGrow: function () { switchAciTab('grow'); },
      openPk: function () { switchAciTab('pk'); },
      refresh: function () { refreshAciGrow(); refreshAciPk(); },
      switchTab: switchAciTab,
    },
    alaCfgApi: {
      get: alaCfg, set: alaSetCfg, probe: alaProbeNow, mode: alaMode, MODES: ALA_MODES,
      caps: alaCaps, setCaps: alaSetCaps, ro: alaReadOnly, actReady: actReady,
      roToggle: function () { roHook.toggle(); }, roPaint: function () { roHook.paint(); },
      /* 口型/朗读状态（调试与自测用） */
      talkNow: function () { var g = gl3d || gl3dFab; return g ? !!g.isTalking() : false; },
      net: alaNetCfg, setNet: alaSetNet, netSearch: alaNetSearch,
      tts: alaTtsCfg, setTts: alaSetTts, speak: speak, stopSpeak: stopSpeak,
      speakSeg: speakSeg, speakable: speakable,
      links: pushLinks, openLink: openLink, clearChat: clearChat, del: deleteItem,
      rate: function () { return loadRate(); }, clearRate: function () { saveRate([]); },
      /* 上下文窗口（调试/自测用：看看到底记住了几轮，也能灌数据验裁剪） */
      hist: function () { return alaHist.slice(); },
      histSet: function (a) { alaHist = Array.isArray(a) ? a.slice() : []; trimHist(); return alaHist.length; },
      ttsProbe: function () { ttsProbed = null; ttsProbedAt = 0; return probeTts(); },
    },
    /* 测试与外部调用：直接跑一批动作 / 灌入动作卡片 */
    act: { run: alaAct, push: pushActCard, runOne: runOne, runActions: runActions },
    /* 催办（测试用：到点没打勾的清单 / 立刻催一次） */
    nag: {
      queue: nagQueue, once: nudgeNow, reset: function () { mem.nag = null; saveMem(); },
    },
    /* 喂给模型的那段话（调试/自测用：能看到模型到底看见了什么） */
    facts: alaFacts,
    /* 表情/动作指令（调试/自测用） */
    fun: { intent: funIntent, run: funDo, rules: FUN_RULES },
    /* 现实条件（调试/自测用：天气识别与户外改室内） */
    wx: { bad: weatherBad, hint: weatherHint, adjust: adjustForWeather },
    /* 往面板里塞一句话（调试/自测用，走的是和正式消息同一条渲染路径） */
    say: pushMsg,
  };
})();
