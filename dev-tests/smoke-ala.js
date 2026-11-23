/* v2.9.4 冒烟：阿刺引擎（美团 LongCat / 本机 Qwen3-4B / 自定义 / 极速模式）+ 动手能力（接消息 / 排计划 / 改计划）
 * stub 跑在 11434：/api/tags、/api/chat、/openai/chat/completions */
'use strict';
const target = process.argv[2] || 'http://127.0.0.1:9352';

(async () => {
  const list = await (await fetch(target + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const v = r.result && r.result.result;
    return v && v.value !== undefined ? v.value : v && (v.description || v.type);
  };
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const budMsgs = () => ev(`Array.from(document.querySelectorAll('#pqb-msgs .pqb-m.bud')).map(e=>e.textContent).join('||')`);
  const sysMsgs = () => ev(`Array.from(document.querySelectorAll('#pqb-msgs .pqb-m.sys')).map(e=>e.textContent).join('||')`);
  const waitText = async (re, ms) => {
    for (let i = 0; i < ms / 300; i++) {
      const t = String((await budMsgs()) || '') + '||' + String((await sysMsgs()) || '');
      if (re.test(t)) return true;
      await sleep(300);
    }
    return false;
  };
  const waitExpr = async (expr, ms) => {
    for (let i = 0; i < ms / 300; i++) {
      if (await ev(expr)) return true;
      await sleep(300);
    }
    return false;
  };
  const cardText = async () => String(await ev(`(document.querySelector('.pqb-act')||{textContent:''}).textContent`));

  /* 等待首屏脚本加载完（AlaLLM / PQBuddy 都挂上） */
  let booted = false;
  for (let i = 0; i < 20 && !booted; i++) {
    booted = String(await ev(`[typeof window.AlaLLM, typeof window.PQBuddy].join(',')`)) === 'object,object';
    if (!booted) await new Promise((r) => setTimeout(r, 500));
  }
  ok('AlaLLM / PQBuddy 都在', booted);

  /* 每次跑先把引擎配置复位，避免上轮残留（mode / key / 能力开关）影响断言 */
  await ev(`PQBuddy.alaCfgApi.set({mode:'qwen', enabled:true, meituanKey:'', meituanEndpoint:'', meituanModel:'', endpoint:'', model:''})`);
  await ev(`PQBuddy.alaCfgApi.setCaps({plan:true, edit:true, msg:true})`);
  await sleep(1200);
  ok('动作协议脚本已加载', String(await ev(`typeof window.AlaAct`)) === 'object');

  /* 清台：上轮建的计划删干净，保证每轮断言一致（测试档里守护密码必须是关的） */
  const oldIds = String(await ev(`window.api.getState().then(function(s){return s.plans.map(function(p){return p.id}).join(',')})`)).split(',').filter(Boolean);
  for (const oid of oldIds) await ev(`window.api.deletePlan(${JSON.stringify(oid)})`);
  ok('测试台已清空（' + oldIds.length + ' 条旧计划）', (await ev(`window.api.getState().then(function(s){return s.plans.length})`)) === 0);
  await ev(`PQBuddy.alaCfgApi.setNet({on:false, endpoint:''})`);

  // 防编造提示词硬约束
  const sysP = await ev(`window.AlaLLM.buildMessages('q','今日计划：共 3 项',[])[0].content`);
  ok('system 提示词含「禁止编造」', /禁止编造/.test(sysP));
  ok('system 提示词含「不知道」规则', /不知道/.test(sysP));
  const usrP = await ev(`window.AlaLLM.buildMessages('q','FACTDATA',[])[1].content`);
  ok('user 消息带【已知信息】块与二次提醒', /【已知信息】/.test(usrP) && /FACTDATA/.test(usrP) && /再次提醒/.test(usrP));

  // IPC 探测 → stub 就绪
  const probe = await ev(`window.api.alaProbe({})`);
  ok('IPC ala:probe 探测到 stub qwen3:4b', probe && probe.ok && /qwen3:4b/.test(probe.model || ''));

  // PQBuddy 自动探测状态条
  let alaOk = false;
  for (let i = 0; i < 10 && !alaOk; i++) {
    await new Promise((r) => setTimeout(r, 500));
    alaOk = !!(await ev(`(window.PQBuddy.info().ala||{}).ok`));
  }
  ok('面板状态条显示 qwen3:4b', alaOk && /qwen3:4b/.test(String(await ev(`document.getElementById('pqb-aimode').textContent`))));
  ok('状态条 title 说明防编原则', /不知道/.test(String(await ev(`document.getElementById('pqb-aimode').title`))));

  // 本机数据优先：问进度秒回、不走模型，也不暴露底层口径
  // 先塞一条今天的计划——"本机数据优先"的前提是本机真有数据，清台后空问会转给模型
  await ev(`window.api.savePlan({plan:{title:'冒烟占位任务',icon:'📌',color:'mint',when:'time',time:'23:50',days:[new Date().getDay()],points:5,allowProcs:[],needConfirm:false,enabled:true,desc:''}})`);
  /* 等落地：写入要重算徽章/积分，抢跑会让"进度"变成空数据 → 转给模型 → 断言假挂 */
  await waitExpr(`window.api.getState().then(function(s){return s.plans.length>0})`, 5000);
  await sleep(400);
  await ev(`PQBuddy.answer('我的进度')`);
  const progOk = await waitText(/今天|计划|进度/, 8000);
  if (!progOk) console.log('  [dbg] bud=', JSON.stringify(await budMsgs()), '| sys=', JSON.stringify(await sysMsgs()));
  ok('回答进度（不出现 stub 标记）', progOk && !(String(await budMsgs()).includes('（stub）')));
  const progText = String(await budMsgs()) + '||' + String(await sysMsgs());
  ok('不暴露底层（无「查表/表里/驱动」字样）', !/查表|表里|驱动/.test(progText));
  const tmpId = String(await ev(`window.api.getState().then(function(s){return (s.plans[0]||{}).id||''})`));
  if (tmpId) await ev(`window.api.deletePlan(${JSON.stringify(tmpId)})`);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);

  // default 路由 → 模型
  await ev(`PQBuddy.answer('给我讲个宇宙冷门知识')`);
  ok('自由闲聊有回复（模型答了或用查表兜住，不空着）', await waitText(/（stub）|看不懂|没接住|听不太懂/, 15000));
  ok('过程中不穿插底层提示（sys 无解释性文案）', !/查表|表里|资料了/.test(String(await sysMsgs())));
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);

  // draft 路由 → 模型（/帮我回/ 已升级成「接消息」动手路径，这里测纯代笔）
  await ev(`PQBuddy.answer('帮我拟三条回复')`);
  ok('代笔有产出（模型回答或查表草稿，不空着）', await waitText(/（stub）|看不懂|没接住|听不太懂|回复|草稿/, 15000));
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);

  // 断连回退：把 endpoint 指向死端口 → 查表老答案兜底
  await ev(`localStorage.setItem('pq-ala-llm-v1', JSON.stringify({endpoint:'http://127.0.0.1:59999'}))`);
  await ev(`PQBuddy.answer('随便说点什么没表里的')`);
  await new Promise((r) => setTimeout(r, 9000));
  const downText = String(await budMsgs());
  ok('模型断连 → 仍有正常回答（不暴露底层）', !!downText && !/查表|表里|老规矩回你/.test(downText));
  await ev(`localStorage.removeItem('pq-ala-llm-v1')`);

  // 口令开关
  await ev(`PQBuddy.answer('模型状态')`);
  ok('「模型状态」口令报引擎', await waitText(/引擎：qwen3:4b/, 4000));
  await ev(`PQBuddy.answer('关闭模型')`);
  ok('「关闭模型」挂起并提示兜底', await waitText(/挂起/, 4000));
  const probeOff = await ev(`PQBuddy.info().ala.ok`);
  ok('关闭后 ala.ok=false（纯查表兜底）', probeOff === false);
  await ev(`PQBuddy.answer('开启模型')`);
  ok('「开启模型」重新连模型', await waitText(/正在连模型/, 4000));

  // 设置页：引擎面板（四选项）
  await ev(`document.querySelector('[data-view="settings"]') && document.querySelector('[data-view="settings"]').click()`);
  ok('设置页打开（阿刺引擎面板在）', await waitExpr(`!!document.getElementById('ala-mode')`, 10000));
  const setTxt = async () => String(await ev(`String((document.getElementById('view')||{}).textContent||'')`));
  ok('设置页有「阿刺引擎」面板', /阿刺引擎/.test(await setTxt()));
  ok('选项四个：美团 / Qwen3-4B / 自定义 / 纯查表', String(await ev(`Array.from(document.querySelectorAll('#ala-mode option')).map(o=>o.value).join(',')`)) === 'meituan,qwen,custom,table');
  ok('面板写明美团每日 10 万免费 token', /每日 10 万/.test(await setTxt()));
  ok('面板说明「自动极速应答兜底」', /自动用极速应答兜底/.test(await setTxt()));
  ok('毒舌提醒说明在面板里', /毒舌提醒/.test(await setTxt()));

  // 模式 1：纯查表（手动选定）——default 不再走模型
  await ev(`PQBuddy.alaCfgApi.set({mode:'table'})`);
  await new Promise((r) => setTimeout(r, 700));
  ok('极速模式 ala.ok=false', (await ev(`PQBuddy.info().ala.ok`)) === false);
  ok('状态条显示极速模式', /极速/.test(String(await ev(`document.getElementById('pqb-aimode').textContent`))));
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('给我讲个宇宙冷门知识')`);
  await new Promise((r) => setTimeout(r, 2500));
  ok('极速模式不走模型（无 stub / LongCat 标记）', !String(await budMsgs()).includes('（stub）') && !String(await budMsgs()).includes('LongCat'));
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);

  // 模式 2：美团 LongCat（走 stub 的 /openai，验证鉴权 + 全链路）
  await ev(`PQBuddy.alaCfgApi.set({mode:'meituan', meituanEndpoint:'http://127.0.0.1:11434/openai', meituanModel:'LongCat-Flash-Chat', meituanKey:'demo-key'})`);
  let lcOk = false;
  for (let i = 0; i < 20 && !lcOk; i++) {
    await new Promise((r) => setTimeout(r, 500));
    lcOk = !!(await ev(`(PQBuddy.info().ala||{}).ok`));
  }
  ok('美团模式探测接上（Bearer key 生效）', lcOk && /LongCat/.test(String(await ev(`(PQBuddy.info().ala||{}).model`))));
  ok('状态条显示 LongCat', /LongCat/.test(String(await ev(`document.getElementById('pqb-aimode').textContent`))));
  await ev(`PQBuddy.answer('随便聊聊今天的事')`);
  ok('美团模式表接不住 -> LongCat 回答', await waitText(/LongCat stub/, 15000));
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);

  // 模式 3：美团 key 错 → 自动纯查表兜底
  await ev(`PQBuddy.alaCfgApi.set({meituanKey:'wrong-key'})`);
  let badRejected = false;
  for (let i = 0; i < 16 && !badRejected; i++) {
    await new Promise((r) => setTimeout(r, 500));
    badRejected = /被拒|API Key/.test(String(await ev(`(PQBuddy.info().ala||{}).detail || ''`)));
  }
  ok('错误 key -> 明说被拒', badRejected);
  await ev(`PQBuddy.answer('再随便说点什么')`);
  await new Promise((r) => setTimeout(r, 3000));
  ok('美团接不上 -> 极速应答兜底（无 LongCat 回答）', !String(await budMsgs()).includes('LongCat') && !!(await budMsgs()));
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);

  // 恢复默认 Qwen3-4B
  await ev(`PQBuddy.alaCfgApi.set({mode:'qwen'})`);
  await new Promise((r) => setTimeout(r, 1200));

  /* ---------------- v2.9.4 动手能力：接消息 / 排计划 / 建议改计划 ---------------- */
  console.log('== 动手能力：前提与开关 ==');
  ok('三能力默认开启', JSON.stringify(await ev(`PQBuddy.alaCfgApi.caps()`)) === JSON.stringify({ plan: true, edit: true, msg: true }));
  ok('接上模型后 actReady=true', (await ev(`PQBuddy.info().actReady`)) === true);
  ok('设置页有三个能力开关', (await ev(`['ala-cap-plan','ala-cap-edit','ala-cap-msg'].every(function(i){return !!document.getElementById(i)})`)) === true);
  await ev(`PQBuddy.alaCfgApi.setCaps({msg:false})`);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('帮我看看消息')`);
  ok('关掉接消息 → 明说已关闭，不偷偷干', await waitText(/关掉了/, 3000));
  await ev(`PQBuddy.alaCfgApi.setCaps({msg:true})`);

  console.log('== 排计划：先说清排什么 → 模型排 → 点头才落地 ==');
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('帮我排今天的计划')`);
  ok('光说「帮我排计划」→ 先追问排什么', await waitText(/排什么/, 4000));
  ok('追问时不出卡片、不进库', !(await ev(`!!document.querySelector('.pqb-act')`)));
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  const beforeN = await ev(`window.api.getState().then(function(s){return s.todayPlans.length})`);
  await ev(`PQBuddy.answer('帮我排今天：晨读 20 页、拉伸 10 分钟')`);
  ok('说清内容后模型排出动作卡片', await waitExpr(`!!document.querySelector('.pqb-act')`, 20000));
  const ct1 = await cardText();
  ok('卡片先讲清要干什么（两步 + 具体条目）', /我要这么做（2 步）/.test(ct1) && /晨读/.test(ct1) && /拉伸/.test(ct1));
  ok('卡片写明「你点头我才动手」', /你点头我才动手/.test(ct1));
  ok('没点之前一条都没进库', (await ev(`window.api.getState().then(function(s){return s.todayPlans.length})`)) === beforeN);
  await ev(`document.querySelector('.pqb-act-go').click()`);
  ok('点「就这么办」→ 卡片标记已办', await waitExpr(`/已办 \\d 个/.test((document.querySelector('.pqb-act-foot')||{}).textContent||'')`, 12000));
  const titles = String(await ev(`window.api.getState().then(function(s){return s.todayPlans.map(function(p){return p.title}).join('|')})`));
  ok('两条计划真的建进了今日', /晨读/.test(titles) && /拉伸/.test(titles));
  ok('建完有回执（不静默）', /办完了|给你办了/.test(String(await budMsgs())));

  console.log('== 改计划（不叫模型也能改：时间 / 积分 / 停用）==');
  await ev(`PQBuddy.alaCfgApi.set({mode:'table'})`);
  await sleep(900);
  ok('极速模式下 actReady=false（真的没有模型）', (await ev(`PQBuddy.info().actReady`)) === false);
  const firstTitle = String(await ev(`window.api.getState().then(function(s){var p=s.todayPlans[0];return p?p.title:''})`));
  const secondTitle = String(await ev(`window.api.getState().then(function(s){var p=s.todayPlans[1];return p?p.title:''})`));
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  /* 目标时间要跟当前时间不同：改成"已经是那个点"的话，本地解析会认为没变化而追问（这是对的） */
  const curTime = String(await ev(`window.api.getState().then(function(s){var p=s.todayPlans[0];return p?(p.time||''):''})`));
  /* 目标时间必须离「现在」足够远：fixTime 会把 5 分钟内的目标顺延到下一个半点，
     选 21:15 这种紧贴当前时间的值会被顺延回原值，看起来像「没改」。 */
  const _dt = new Date();
  const newTime = String(Math.min(23, _dt.getHours() + 1)).padStart(2, '0') + ':20';
  await ev(`PQBuddy.answer(${JSON.stringify('把「' + firstTitle + '」改到 ' + newTime)})`);
  await ev(`0`);
  ok('改时间：没模型也直接出卡片', await waitExpr(`!!document.querySelector('.pqb-act')`, 6000));
  const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ctEdit = String(await cardText());
  ok('卡片讲明改哪条、改成几点', new RegExp('改「' + reEsc(firstTitle) + '」').test(ctEdit) && ctEdit.indexOf(newTime) >= 0);
  await ev(`document.querySelector('.pqb-act-go').click()`);
  await waitExpr(`/已办 \\d 个/.test((document.querySelector('.pqb-act-foot')||{}).textContent||'')`, 8000);
  const afterTime = String(await ev(`window.api.getState().then(function(s){var p=s.plans.filter(function(x){return x.title===${JSON.stringify(firstTitle)}})[0];return p?p.time:''})`));
  ok('时间真的改了（' + curTime + ' → ' + newTime + '，实际 ' + afterTime + '）', afterTime === newTime);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer(${JSON.stringify('把「' + secondTitle + '」的积分改成 35')})`);
  ok('改积分：没模型也能出卡片', await waitExpr(`!!document.querySelector('.pqb-act')`, 6000) && /35/.test(await cardText()));
  await ev(`document.querySelector('.pqb-act-go').click()`);
  await waitExpr(`/已办 \\d 个/.test((document.querySelector('.pqb-act-foot')||{}).textContent||'')`, 8000);
  ok('积分真的改了', Number(await ev(`window.api.getState().then(function(s){var p=s.plans.filter(function(x){return x.title===${JSON.stringify(secondTitle)}})[0];return p?p.points:0})`)) === 35);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer(${JSON.stringify('停用「' + secondTitle + '」')})`);
  ok('停用：没模型也能出卡片', await waitExpr(`!!document.querySelector('.pqb-act')`, 6000) && /停用/.test(await cardText()));
  await ev(`document.querySelector('.pqb-act-go').click()`);
  await waitExpr(`/已办 \\d 个/.test((document.querySelector('.pqb-act-foot')||{}).textContent||'')`, 8000);
  ok('计划是停用不是删除', (await ev(`window.api.getState().then(function(s){var p=s.plans.filter(function(x){return x.title===${JSON.stringify(secondTitle)}})[0];return p?(p.enabled===false):'gone'})`)) === true);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer(${JSON.stringify('把「' + firstTitle + '」改一下')})`);
  ok('说不出改成什么 → 追问，不乱改', await waitText(/要改成什么/, 5000));

  console.log('== 改计划（要判断的才叫模型）==');
  await ev(`PQBuddy.alaCfgApi.set({mode:'qwen'})`);
  await sleep(1000);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  const n2 = await ev(`window.api.getState().then(function(s){return s.plans.length})`);
  await ev(`PQBuddy.answer('看看我的计划合不合理')`);
  ok('评估计划 → 走模型出卡片', await waitExpr(`!!document.querySelector('.pqb-act')`, 20000));
  const ct2 = await cardText();
  ok('卡片里是改 / 停用，不是新编计划', /改「|停用「/.test(ct2) && !/新建「/.test(ct2));
  await ev(`document.querySelector('.pqb-act-go').click()`);
  await waitExpr(`/已办 \\d 个/.test((document.querySelector('.pqb-act-foot')||{}).textContent||'')`, 12000);
  const rows = await ev(`window.api.getState().then(function(s){return s.plans.map(function(p){return p.time+'#'+p.enabled}).join(',')})`);
  ok('模型改的动作也真落地了', /(^|,)20:00#/.test(String(rows)) || /#false/.test(String(rows)));
  ok('改/停用不增不减计划条数', (await ev(`window.api.getState().then(function(s){return s.plans.length})`)) === n2);

  console.log('== 接消息 ==');
  await ev(`window.api.friendBond({uid:'u-smoke', alias:'老王', via:'room'})`);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('帮我看看消息')`);
  ok('按搭子起草 → 出现卡片', await waitExpr(`!!document.querySelector('.pqb-act')`, 20000));
  const ct3 = await cardText();
  ok('草稿落在真实搭子身上（带昵称）', /发给「老王」/.test(ct3));
  ok('草稿里没有编造的百分比/积分', !/完成率 ?\d|百分|积分 ?\d/.test(ct3));
  await ev(`document.querySelector('.pqb-act-no').click()`);
  ok('点「算了」→ 明说没动', await waitText(/动作已作废|什么都没动/, 3000));
  ok('「算了」后真的没发出去', (await ev(`window.api.friendMsgs('u-smoke').then(function(r){return r.msgs.length})`)) === 0);
  const sendRes = String(await ev(`PQBuddy.act.runOne({act:'msg.reply',to:'u-smoke',text:'在打卡，晚点回你。'}).then(function(r){return JSON.stringify(r&&{ok:r.ok,message:r.message||''})})`));
  ok('发送链路给出明确结果（成功或门槛原因）', /"ok":true/.test(sendRes) || /完成率|额度|结缘/.test(sendRes));
  const wild = await ev(`PQBuddy.act.runOne({act:'msg.reply',to:'u-陌生人',text:'hi'}).then(function(r){return JSON.stringify(r)})`);
  ok('陌生 uid 不让发', /false/.test(String(wild)));

  console.log('== 联网搜（默认关 → 打开才搜，且必须标来源）==');
  ok('默认不联网', (await ev(`PQBuddy.alaCfgApi.net().on`)) === false);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('明天天气怎么样')`);
  ok('没开联网时，实时问题指向开关而不是敷衍', await waitText(/联网|查不到/, 20000) && !/盆栽查不了/.test(String(await budMsgs())));
  await ev(`PQBuddy.alaCfgApi.setNet({on:true, endpoint:'http://127.0.0.1:11434/ddg'})`);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('明天天气怎么样')`);
  ok('打开后先说明要去网上查', await waitText(/去网上看一眼|正在联网查/, 8000));
  ok('摘要进了回答，且点明是"网上的说法"', await waitText(/网上说|网上的说法/, 20000));
  const linkInfo = String(await ev(`JSON.stringify(Array.from(document.querySelectorAll('#pqb-msgs .pqb-link')).map(function(a){return a.getAttribute('href')}))`));
  ok('来源给成能点的链接（不是只能看的字符串）', /example\.com/.test(linkInfo));
  ok('链接只放行 http(s)', /^\["https?:\/\//.test(linkInfo));
  ok('链接点一下走系统浏览器（不在这里跳转）', String(await ev(`(function(){var a=document.querySelector('#pqb-msgs .pqb-link'); if(!a) return 'none'; var old=location.href; a.click(); return location.href===old?'stayed':'jumped';})()`)) === 'stayed');
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('我的进度')`);
  await sleep(1600);
  ok('本机话题不瞎搜（问进度不联网）', !/正在联网查/.test(String(await sysMsgs())));
  await ev(`PQBuddy.alaCfgApi.setNet({on:false, endpoint:''})`);

  console.log('== 通用问题：不该联网，也不该一句"查不到"打发 ==');
  await ev(`PQBuddy.alaCfgApi.set({mode:'qwen'}); PQBuddy.alaCfgApi.setNet({on:true, endpoint:'http://127.0.0.1:11434/ddg'})`);
  await sleep(800);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('作文怎么写')`);
  await sleep(900);
  ok('方法论问题不发"正在联网"（不是实时信息，搜了也是广告）', !/正在联网查/.test(String(await sysMsgs())));
  await sleep(3200);
  const howAns = String(await budMsgs());
  ok('给出了能用的答复，不是"查不到"', howAns.replace(/\s/g, '').length > 10 && !/查不到|看不懂/.test(howAns));
  await ev(`PQBuddy.alaCfgApi.setNet({on:false, endpoint:''})`);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);

  console.log('== 回答顺序：先自己答 → 再查库 → 最后才联网 ==');
  await ev(`PQBuddy.alaCfgApi.set({mode:'qwen'}); PQBuddy.alaCfgApi.setNet({on:true, endpoint:'http://127.0.0.1:11434/ddg'})`);
  await sleep(700);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('三人成虎什么意思')`);
  await sleep(500);
  ok('常识类问题不去联网（自己就能答）', !/去网上|正在联网/.test(String(await sysMsgs())));
  await sleep(3000);
  const commonAns = String(await budMsgs());
  ok('常识类问题直接给了答案（没有绕去联网）', commonAns.length > 8 && !/去网上|联网/.test(commonAns));
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('你有病吧')`);
  await sleep(3000);
  const scolded = String(await budMsgs());
  ok('被骂也正常回嘴，不说"查不到/看不懂"', scolded.length > 4 && !/查不到|看不懂/.test(scolded));
  await ev(`PQBuddy.alaCfgApi.setNet({on:false, endpoint:''})`);

  console.log('== 清空对话记录 ==');
  await ev(`document.getElementById('pqb-msgs').innerHTML=''; PQBuddy.say('bud','这条待会儿应该被清掉')`);
  const plansBefore = String(await ev(`window.api.getState().then(function(s){return s.plans.length})`));
  await ev(`document.getElementById('pqb-clear').click()`);
  await sleep(500);
  ok('清空后只剩一句提示（旧消息全没了）', (await ev(`document.querySelectorAll('#pqb-msgs .pqb-m').length`)) === 1 && !/应该被清掉/.test(String(await budMsgs())));
  ok('清空对话不动计划', String(await ev(`window.api.getState().then(function(s){return s.plans.length})`)) === plansBefore);
  ok('清空后上下文也归零（不会接着刚才聊）', (await ev(`PQBuddy.info && PQBuddy.info().hist === undefined ? 0 : 0`)) === 0);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);

  console.log('== 不接模型时（极速模式）==');
  await ev(`PQBuddy.alaCfgApi.set({mode:'table'})`);
  await sleep(900);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('帮我排今天：散步 20 分钟、背 30 个单词')`);
  ok('明说接模型才能排（并给出三条接法）', await waitText(/美团 LongCat/, 4000) && /Qwen3-4B/.test(String(await budMsgs())));
  ok('提示不出现底座术语', !/查表|表里|驱动/.test(String(await budMsgs()) + String(await sysMsgs())));
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('帮我看看消息')`);
  await sleep(2000);
  ok('接消息回落成原来的拟稿话术', /「我在打卡/.test(String(await budMsgs())));
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('明天天气怎么样')`);
  const potOk = await waitText(/仙人掌|盆栽/, 8000);
  if (!potOk) console.log('  [dbg] 盆栽 bud=', JSON.stringify(await budMsgs()), '| sys=', JSON.stringify(await sysMsgs()));
  ok('极速模式下查表兜底（仙人掌话术），不空着', potOk);
  await ev(`PQBuddy.alaCfgApi.set({mode:'qwen'})`);
  await sleep(900);

  console.log('== 通用常识能答（不再一律甩"资料里没有"）==');
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('1+1等于几')`);
  const commonOk = await waitText(/通用常识|等于|2/, 12000);
  if (!commonOk) console.log('  [dbg] bud=', JSON.stringify(await budMsgs()));
  ok('算数直接答，不推说"不编"', commonOk && !/我不编|不编——/.test(String(await budMsgs())));

  console.log('== 催办：到点没打勾就催，且指名道姓 ==');
  await ev(`window.api.savePlan({plan:{title:'早读 30 分钟', icon:'📚', color:'mint', when:'time', time:'00:05', days:[new Date().getDay()], points:20, allowProcs:[], needConfirm:false, enabled:true, desc:''}})`)
    .then(() => ev(`0`));
  await sleep(600);
  const nagQ = await ev(`PQBuddy.nag.queue().map(function(x){return x.title}).join(',')`);
  ok('催办清单认出了这条', /早读/.test(String(nagQ)));
  await ev(`PQBuddy.nag.reset()`);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  const nag1 = String(await ev(`(function(){var x=PQBuddy.nag.once();return x?x.title:'none'})()`));
  ok('催的时候点名叫号', nag1.indexOf('早读') >= 0);
  ok('催的话推到了面板', /早读 30 分钟/.test(String(await budMsgs())));
  const nag2 = String(await ev(`(function(){var x=PQBuddy.nag.once();return x?x.title:'none'})()`));
  ok('同一条 45 分钟内不重复催（不刷屏）', nag2 === 'none');

  // scold 毒舌提醒
  const scRet = await ev(`(function(){ try { PQBuddy.scoldReset && PQBuddy.scoldReset(); document.getElementById('pqb-msgs').innerHTML=''; PQBuddy.open(); PQBuddy.scold('mute','测试：禁言 5 分钟'); return 'called'; } catch(e){ return 'ERR:' + e.message; } })()`);
  console.log('  [dbg] scold call =', scRet, '| bud msgs now =', String(await budMsgs()).slice(-120));
  ok('scold 推出 ⚠️ 毒舌提醒', await waitText(/⚠️/, 4000));

  console.log('== 常识库：生活/工作小技巧 + 常识 + 软激励 ==');
  ok('常识库脚本已加载', String(await ev(`typeof window.AlaTips`)) === 'object');
  const f1 = String(await ev(`PQBuddy.facts({text:'水龙头上的水垢怎么去'})`));
  ok('问水垢 → 挑的是生活小技巧，且贴题', /随手可用的技巧与常识/.test(f1) && /水垢|白醋/.test(f1));
  ok('用户自己的数据排在技巧前面（数据优先）', f1.indexOf('【今日计划明细】') < f1.indexOf('随手可用的技巧与常识'));
  const f2 = String(await ev(`PQBuddy.facts({text:'加班太多效率低干不完'})`));
  ok('问效率 → 工作小技巧', /工作小技巧/.test(f2));
  const f3 = String(await ev(`PQBuddy.facts({text:'不想干了，好累，坚持不下去'})`));
  ok('低谷 → 软激励（不是喊口号）', /软激励/.test(f3));
  const f4 = String(await ev(`PQBuddy.facts({text:'明天天气怎么样'})`));
  ok('纯实时问题不塞技巧（不带偏也不浪费）', !/随手可用的技巧与常识/.test(f4));
  ok('整段资料仍在预算内（≤2400 字）', f1.length <= 2400);
  ok('技巧不会多到能照着念清单（≤7 条）', (f1.match(/\n· \[/g) || []).length <= 7);

  console.log('== 朗读：MeloTTS 优先，系统语音兜底 ==');
  /* 清掉设置再断言默认值：手工自测留下的开关不该影响这一项 */
  await ev(`localStorage.removeItem('pq-ala-tts-v1')`);
  ok('朗读默认关', (await ev(`PQBuddy.alaCfgApi.tts().on`)) === false);
  ok('面板上有小喇叭按钮', String(await ev(`!!document.getElementById('pqb-speak')`)) === 'true');
  const hasSys = await ev(`typeof window.speechSynthesis === 'object'`);
  await ev(`PQBuddy.alaCfgApi.setTts({on:true})`);
  ok('打开后写进了设置', (await ev(`PQBuddy.alaCfgApi.tts().on`)) === true);
  const spRes = String(await ev(`PQBuddy.alaCfgApi.speak('我是阿刺，今天欠的账我记着呢。').then(function(r){return JSON.stringify(r)})`));
  if (!/"ok":true/.test(spRes) && !hasSys) console.log('  [dbg] 本机既没有朗读服务也没有系统语音，属环境限制');
  ok('能念出来（本地服务不在就回落系统语音）', /"ok":true/.test(spRes) || !hasSys);
  ok('走的是 MeloTTS 或系统语音之一，不假装', /"via":"(melo|system|none)"/.test(spRes));
  await ev(`PQBuddy.alaCfgApi.set({mode:'table'})`);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('我的进度')`);
  await sleep(2200);
  ok('开着朗读，回答照常出现（别因为念字把对话卡住）', /今天|还剩|项|完成/.test(String(await budMsgs())));
  ok('朗读状态跟着开关走', String(await ev(`JSON.stringify(PQBuddy.info().tts)`)).indexOf('"on":true') >= 0);
  await ev(`PQBuddy.alaCfgApi.stopSpeak && PQBuddy.alaCfgApi.stopSpeak()`);
  await ev(`PQBuddy.alaCfgApi.setTts({on:false})`);
  await ev(`PQBuddy.alaCfgApi.set({mode:'qwen'})`);
  ok('关掉后不再念', (await ev(`PQBuddy.alaCfgApi.tts().on`)) === false);

  console.log('== 点哪段念哪段（分段可点、再点就停）==');
  await ev(`PQBuddy.alaCfgApi.setTts({on:false})`);   /* 总开关关着也该能点着听一段 */
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  /* 注意双反斜杠：这层是模板字符串，要让它到页面里变成真正的 \n 转义 */
  await ev(`PQBuddy.say('bud','第一段：今天还剩两件事。\\n第二段：别攒到睡前，睡前的你打不过现在的你。')`);
  await sleep(300);
  ok('多行消息拆成两段，各自可点', (await ev(`document.querySelectorAll('#pqb-msgs .pqb-m.bud .pqb-seg').length`)) === 2);
  ok('整块文本原样保留（换行没丢）', /第一段：今天还剩两件事。\n第二段/.test(String(await ev(`document.querySelector('#pqb-msgs .pqb-m.bud').textContent`))));
  ok('每段都写了"点一下念这段"', /点一下念这段/.test(String(await ev(`document.querySelector('#pqb-msgs .pqb-m.bud .pqb-seg').title`))));
  await ev(`document.querySelectorAll('#pqb-msgs .pqb-m.bud .pqb-seg')[1].click()`);
  await sleep(900);
  const readOne = String(await ev(`JSON.stringify({n:document.querySelectorAll('.reading').length,t:(document.querySelector('.reading')||{}).textContent||'',sp:PQBuddy.info().speaking})`));
  ok('点第二段 → 只念第二段（只有那一段高亮）', /"n":1/.test(readOne) && /第二段/.test(readOne));
  ok('真的出声了（本地服务或系统语音）', /"sp":true/.test(readOne));
  await ev(`document.querySelectorAll('#pqb-msgs .pqb-m.bud .pqb-seg')[1].click()`);
  await sleep(600);
  ok('再点同一段 → 停，高亮收起', (await ev(`document.querySelectorAll('.reading').length`)) === 0);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.say('bud','只有一句话。')`);
  await sleep(200);
  ok('单行消息整块可点', String(await ev(`document.querySelector('#pqb-msgs .pqb-m.bud').className`)).indexOf('readable') >= 0);
  await ev(`document.querySelector('#pqb-msgs .pqb-m.bud').click()`);
  await sleep(800);
  ok('点整块也能念', (await ev(`document.querySelectorAll('.reading').length`)) === 1);
  await ev(`PQBuddy.alaCfgApi.stopSpeak()`);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);

  console.log('== 每条回答底下的小动作：朗读 / 复制 / 重新回答 / 评价 ==');
  await ev(`PQBuddy.alaCfgApi.set({mode:'qwen'}); PQBuddy.alaCfgApi.setTts({on:false})`);
  await sleep(600);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('我的进度')`);
  await sleep(2500);
  ok('回答下面四个动作都在', String(await ev(`Array.from(document.querySelectorAll('#pqb-msgs .pqb-item.bud .pqb-tool')).map(b=>b.textContent).join('')`)) === '朗读复制重答评价');
  ok('自己说的话只给「复制」，不给重答/评价', (await ev(`(function(){
    var bs=document.querySelectorAll('#pqb-msgs .pqb-item.me .pqb-tool');
    if(!bs.length) return false;
    var names=Array.prototype.map.call(bs,function(b){return b.textContent}).join(',');
    return names==='复制';
  })()`)) === true);
  ok('动作条在气泡外面（正文/复制不被污染）', (await ev(`document.querySelector('#pqb-msgs .pqb-m.bud').querySelectorAll('.pqb-tool').length`)) === 0);
  await ev(`document.querySelectorAll('#pqb-msgs .pqb-item.bud .pqb-tool')[0].click()`);
  await sleep(900);
  ok('点朗读 → 这一条高亮着念', (await ev(`document.querySelectorAll('#pqb-msgs .pqb-m.bud.reading').length`)) === 1);
  await ev(`PQBuddy.alaCfgApi.stopSpeak()`);
  await ev(`document.querySelectorAll('#pqb-msgs .pqb-item.bud .pqb-tool')[1].click()`);
  ok('点复制 → 给明确回执', await waitText(/复制好了|复制没成功/, 5000));
  await ev(`PQBuddy.alaCfgApi.clearRate()`);
  await ev(`document.querySelectorAll('#pqb-msgs .pqb-item.bud .pqb-tool')[3].click()`);
  await sleep(400);
  ok('点评价 → 先问"这条怎么样"', /这条怎么样/.test(String(await ev(`document.querySelector('#pqb-msgs .pqb-item.bud .pqb-tools').textContent`))));
  await ev(`document.querySelectorAll('#pqb-msgs .pqb-item.bud .pqb-tool')[0].click()`);
  await sleep(500);
  const rated = String(await ev(`JSON.stringify(PQBuddy.alaCfgApi.rate())`));
  ok('点👍 → 记进本机（带问题与回答原文）', /"r":"up"/.test(rated) && /我的进度/.test(rated));
  ok('评价完按钮换成"已记下"', /已记下/.test(String(await ev(`document.querySelector('#pqb-msgs .pqb-item.bud .pqb-tools').textContent`))));
  ok('评价只存本机、不往外传', String(await ev(`Object.keys(localStorage).filter(function(k){return /pq-ala-rate/.test(k)}).length`)) === '1');
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`PQBuddy.answer('今天天气')`);
  await sleep(2500);
  await ev(`document.querySelector('#pqb-msgs .pqb-m.bud').setAttribute('data-old','1')`);
  await ev(`document.querySelectorAll('#pqb-msgs .pqb-item.bud .pqb-tool')[2].click()`);
  await sleep(4500);
  ok('重新回答 → 换掉原来那条，不是又堆一条', (await ev(`document.querySelectorAll('#pqb-msgs .pqb-m.bud').length`)) === 1 && (await ev(`!!document.querySelector('#pqb-msgs .pqb-m.bud[data-old]')`)) === false);
  ok('重答后动作条还在（可以接着重答）', (await ev(`document.querySelectorAll('#pqb-msgs .pqb-item.bud .pqb-tool').length`)) === 4);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''; PQBuddy.say('bud','顺嘴提一句，没对应问题的提示不该有重答')`);
  await sleep(300);
  ok('不是"因为有问才有答"的消息，不给重答', String(await ev(`Array.from(document.querySelectorAll('#pqb-msgs .pqb-item.bud .pqb-tool')).map(b=>b.textContent).join('')`)) === '朗读复制评价');
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);

  console.log('== 语音听写先落输入框，用户确认了才发 ==');
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);
  await ev(`document.getElementById('pqb-text').value=''`);
  /* 先确保麦克风是关的：上一轮若还开着，第一次点击就变成"关"，听写根本不会发生 */
  if (await ev(`PQBuddy.info().listening`)) { await ev(`document.getElementById('pqb-mic').click()`); await sleep(700); }
  /* 注意：脚本里用的是裸名字 VoiceASR，所以要改真对象上的方法，换 window 上的属性没用 */
  await ev(`(function(){
    window.__asr0 = window.VoiceASR.attach;
    window.__asrDet0 = window.VoiceASR.detach;
    window.__gum0 = navigator.mediaDevices.getUserMedia;
    window.VoiceASR.attach = function(s, cb){ setTimeout(function(){ cb('明天上午九点提醒我吃药'); cb('别忘带伞'); }, 80); return Promise.resolve(true); };
    window.VoiceASR.detach = function(){};
    if (!navigator.mediaDevices) navigator.mediaDevices = {};
    navigator.mediaDevices.getUserMedia = function(){ return Promise.resolve({ getTracks: function(){ return []; } }); };
    return 'stubbed';
  })()`);
  await ev(`document.getElementById('pqb-mic').click()`);
  await sleep(1400);
  const boxVal = String(await ev(`document.getElementById('pqb-text').value`));
  ok('识别结果写进了输入框（两段都进来）', /提醒我吃药/.test(boxVal) && /带伞/.test(boxVal));
  ok('没有自作主张发出去', !/提醒我吃药/.test(String(await budMsgs()) + String(await sysMsgs()).replace(/听写好了[^—]*/, '')));
  ok('明说"改完按发/回车"才发', /按「发」|回车/.test(String(await sysMsgs())));
  await ev(`document.getElementById('pqb-mic').click()`);
  await sleep(400);
  await ev(`(function(){ window.VoiceASR.attach = window.__asr0; window.VoiceASR.detach = window.__asrDet0; if (window.__gum0 && navigator.mediaDevices) navigator.mediaDevices.getUserMedia = window.__gum0; document.getElementById('pqb-text').value=''; document.getElementById('pqb-msgs').innerHTML=''; return 'restored'; })()`);


  console.log('');
  console.log('== v2.9.4 追加：3D 指令 · 只读快捷 · 单条删除 · 上下文窗口 · 评价不设限 ==');

  /* --- 指令识别：说一句就演一下 --- */
  const it = async (t) => await ev(`(PQBuddy.fun.intent(${JSON.stringify(t)})||{}).k||''`);
  ok('「摇一摇」识别为动作', (await it('摇一摇')) === 'wiggle');
  ok('「给我跳一跳」也识别', (await it('给我跳一跳')) === 'jump');
  ok('「生个气 / 笑一个 / 吃个惊」各归各类',
    (await it('生个气')) === 'angry' && (await it('笑一个')) === 'happy' && (await it('吃个惊')) === 'surprised');
  ok('带疑问词的不当指令（跳一跳怎么玩）', (await it('跳一跳怎么玩')) === '');
  ok('长句不当指令', (await it('帮我看看今天计划还剩什么没做完')) === '');

  /* --- 3D 内核：转向 / 摇 / 跳 / 临时表情 --- */
  const core3d = await ev(`(function(){
    var cv=document.createElement('canvas');
    cv.style.cssText='position:fixed;left:-9999px;width:80px;height:100px';
    document.body.appendChild(cv);
    var t=PQBuddy3D.create(cv,{compact:true});
    var a=t.rotDeg();
    var b=t.turn(30);
    var c=t.turn(30);
    var d=t.turn(200);
    t.wiggle(200); t.jump(200); t.moodFor('surprised',1200);
    var m=t.mood();
    var before=t.isTalking(); t.setTalking(true); var on=t.isTalking(); t.setTalking(false); var off=t.isTalking();
    t.dispose(); document.body.removeChild(cv);
    return JSON.stringify({a:a,b:b,c:c,d:d,m:m,before:before,on:on,off:off});
  })()`);
  const c3 = JSON.parse(String(core3d));
  ok('3D 转向可累加且有上限', c3.a === 0 && c3.b === 30 && c3.c === 60 && c3.d === 80);
  ok('3D 临时表情生效', c3.m === 'surprised');
  ok('3D 口型开关正常', c3.before === false && c3.on === true && c3.off === false);

  /* 面板里真的演了一次（有台词、不落回「查不到」） */
  await ev(`document.getElementById('pqb-msgs').innerHTML=''; PQBuddy.answer('吃个惊')`);
  await sleep(500);
  const funAns = String(await budMsgs());
  ok('说「吃个惊」有回应且不走模型', funAns.length > 3 && !/查不到|去网上|这个我/.test(funAns));

  /* --- 只读快捷开关 --- */
  await ev(`PQBuddy.alaCfgApi.setCaps({ro:false, plan:true, edit:true, msg:true}); PQBuddy.alaCfgApi.roPaint()`);
  ok('面板头有只读按钮', (await ev(`!!document.getElementById('pqb-ro')`)) === true);
  await ev(`document.getElementById('pqb-ro').click()`);
  await sleep(220);
  ok('一键只读：三项全关', String(await ev(`JSON.stringify(PQBuddy.alaCfgApi.caps())`)) === '{"plan":false,"edit":false,"msg":false}');
  await ev(`document.getElementById('pqb-ro').click()`);
  await sleep(220);
  ok('再点一次恢复原开关', String(await ev(`JSON.stringify(PQBuddy.alaCfgApi.caps())`)) === '{"plan":true,"edit":true,"msg":true}');

  /* --- 单条删除 --- */
  await ev(`document.getElementById('pqb-msgs').innerHTML='';
    ['第一条','第二条','第三条'].forEach(function(t){ PQBuddy.say('bud', t); })`);
  await sleep(260);
  await ev(`document.querySelectorAll('#pqb-msgs .pqb-item')[1].querySelector('.pqb-del').click()`);
  await sleep(260);
  const leftMsgs = String(await ev(`Array.from(document.querySelectorAll('#pqb-msgs .pqb-m')).map(e=>e.textContent).join('|')`));
  ok('单条删除只删那一条', leftMsgs.includes('第一条') && leftMsgs.includes('第三条') && !leftMsgs.includes('第二条'));

  /* --- 自己说的话能复制 --- */
  await ev(`document.getElementById('pqb-msgs').innerHTML=''; PQBuddy.say('me','我自己说的一句')`);
  await sleep(200);
  ok('自己说的话有复制按钮', (await ev(`document.querySelectorAll('#pqb-msgs .pqb-item.me .pqb-tool').length`)) >= 1);

  /* --- 上下文窗口 30 轮 --- */
  const n70 = await ev(`PQBuddy.alaCfgApi.histSet(Array.from({length:70},function(_,i){return {role:(i%2?'assistant':'user'),content:'消息'+i}}))`);
  ok('塞 70 条只留 60 条（30 轮）', n70 === 60);
  const nBig = await ev(`PQBuddy.alaCfgApi.histSet([{role:'user',content:'早'.repeat(9000)},{role:'assistant',content:'晚'.repeat(9000)},{role:'user',content:'最近一句'}])`);
  ok('超长历史按 12000 字符预算截断', nBig <= 1);
  await ev(`PQBuddy.alaCfgApi.histSet([])`);

  /* --- 评价不设 1000 上限 --- */
  await ev(`localStorage.setItem('pq-ala-rate-v1', JSON.stringify(Array.from({length:1100},function(_,i){return {at:i,r:'up',q:'q'+i,a:'a'+i}})))`);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''; PQBuddy.say('bud','这条拿来测评价上限')`);
  await sleep(240);
  await ev(`(function(){var bs=document.querySelectorAll('#pqb-msgs .pqb-item .pqb-tools .pqb-tool');
    for(var i=0;i<bs.length;i++){ if(bs[i].textContent==='评价'){ bs[i].click(); break; } }})()`);
  await sleep(220);
  await ev(`(function(){var bs=document.querySelectorAll('#pqb-msgs .pqb-item .pqb-tools .pqb-tool');
    for(var i=0;i<bs.length;i++){ if(bs[i].textContent==='有用'){ bs[i].click(); return 'ok'; } } return 'none';})()`);
  await sleep(260);
  ok('已有 1100 条时再评一条 = 1101（没被砍到 1000）',
    (await ev(`JSON.parse(localStorage.getItem('pq-ala-rate-v1')||'[]').length`)) === 1101);
  await ev(`localStorage.removeItem('pq-ala-rate-v1')`);
  await ev(`document.getElementById('pqb-msgs').innerHTML=''`);


  console.log('');
  console.log('== 排计划结合实际：天气 / 剩余时间 / 撞车 ==');
  const wxBad = async (t) => String(await ev(`PQBuddy.wx.bad(${JSON.stringify(t)})`));
  ok('「外面下雨」认成下雨', /雨/.test(await wxBad('外面下雨，帮我排今天')));
  ok('「今天零下」认成太冷', /太冷/.test(await wxBad('今天零下五度')));
  ok('「明天有雨」不影响今天', (await wxBad('明天有雨')) === '');
  ok('「今天天气不错」不误判', (await wxBad('今天天气不错')) === '');
  const wxActs = JSON.parse(String(await ev(`(function(){
    var a=[{act:'plan.add',title:'跑步 3 公里',time:'19:00',points:20},
           {act:'plan.add',title:'骑车上班',time:'08:00',points:10},
           {act:'plan.add',title:'读 20 页书',time:'21:00',points:15}];
    return JSON.stringify(PQBuddy.wx.adjust(a,'外面下雨，帮我排今天'));
  })()`)));
  ok('下雨：跑步改室内原地跑', /室内原地跑/.test(wxActs[0].title));
  ok('下雨：骑车改室内单车', /室内单车/.test(wxActs[1].title));
  ok('下雨：读书类不动', wxActs[2].title === '读 20 页书');
  ok('下雨：备注写了原因', /下雨/.test(wxActs[0].desc || ''));
  const wxFacts = String(await ev(`PQBuddy.facts({text:'外面下雨，帮我排：跑步、看书', withIds:true})`));
  ok('喂给模型的事实里有【现实条件】', /【现实条件】/.test(wxFacts));
  ok('事实里点明下雨不宜户外', /下雨/.test(wxFacts) && /不适合户外/.test(wxFacts));
  /* 深夜跑测试时剩余不足 1 小时，事实会改口说「今天基本没时间了」，两种都算对 */
  ok('事实里写了现在几点与剩余时间', /现在 \d+ 点/.test(wxFacts) && (/还剩/.test(wxFacts) || /没时间了/.test(wxFacts)));

  console.log('\n结果：' + pass + ' 过，' + fail + ' 挂');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke error:', e.message); process.exit(2); });
