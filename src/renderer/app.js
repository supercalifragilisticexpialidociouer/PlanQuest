'use strict';

/* ================= 工具 ================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 把 `connect ECONNREFUSED 127.0.0.1:8899` 这类报文翻成人话。
   用户不需要知道 errno 和端口，只需要知道「服务没开」以及「现在靠什么顶着」。
   非网络类的原因（比如「系统没装中文语音」）本来就是人话，原样返回。 */
function netReason(detail) {
  const raw = String(detail || '').trim();
  if (!raw) return '没连上';
  if (/ECONNREFUSED/i.test(raw)) return '服务没开';
  if (/ETIMEDOUT|timeout|超时/i.test(raw)) return '等太久没回应';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return '地址找不到（域名或 IP 不对）';
  if (/ECONNRESET|socket hang up/i.test(raw)) return '连接被掐断';
  if (/EACCES|EPERM/i.test(raw)) return '被系统挡住了';
  const h = /HTTP\s*(\d{3})/i.exec(raw);
  if (h) {
    const code = Number(h[1]);
    if (code === 401 || code === 403) return '密钥或权限不对';
    if (code === 404) return '地址或模型名不对';
    if (code >= 500) return '对面服务出错了';
    return '返回 HTTP ' + code;
  }
  return raw.length > 42 ? raw.slice(0, 42) + '…' : raw;
}

const DAYS = ['日', '一', '二', '三', '四', '五', '六'];

const COLORS = {
  mint: '#17cda8',
  indigo: '#7c6cff',
  coral: '#ff6b81',
  amber: '#ffb454',
  violet: '#a855f7',
  sky: '#38bdf8',
};

const EMOJIS = ['📖', '🏃', '🧘', '💧', '🧭', '✍️', '🎯', '💻', '🛠️', '🥗', '🎨', '🎸', '🧹', '🌙', '☀️', '📞'];

let state = null;
let currentView = 'today';
let unsubState = null;
let roomMembers = [];
let roomJoined = false;
let chatLog = []; // 房间聊天记录（本机缓存）
let muteSelf = null; // { until, reason } 自己被禁言的截止时间
let chatUnreadAt = 0; // 房间里被人 @ 了但还没翻上去看
let funTickTimer = null; // 娱乐房倒计时刷新
let msgCenter = null;   // 微信式消息弹窗（msg-center.js）
let lgcBooted = false;  // 频道基线是否已建：第一次只登记，不给历史消息补一串弹窗
let lgcSeen = new Set(); // 频道已处理过的消息 id
let friendInboxTimer = null;

/* 平台判定：只有桌面版（Electron file://）才有开机自启 / 专注模式 / 护眼模式。
   安卓 APK 与网页版系统层做不到（隐藏桌面图标是 Windows 专属能力，
   安卓的开机自启被各家系统后台管控拦得七零八落），这三个开关直接不渲染，
   免得用户开了没效果还以为软件坏了。 */
const IS_DESKTOP =
  location.protocol === 'file:' && !(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
const IS_NATIVE = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());

/* ---- AI 闲聊雷达（本地文本分类）状态 ---- */
let aiChatOn = true;            // 强制常开（需求：闲聊雷达不给关，只保留判定与统计）
let aiChatPenalty = true;       // 强制扣分（用户要求不可关）
let aiChatStat = null;          // { total, fish, work, skip }
let aiChatMine = [];            // 最近自己判为闲聊的时间戳（5 分钟窗口）

/* ================= 基础 UI ================= */

function toast(msg, sub = '', warn = false) {
  const root = $('#toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast' + (warn ? ' warn' : '');
  el.innerHTML = `
    <span class="ti">${warn ? '!' : '✓'}</span>
    <div class="tc">
      <div class="tt">${esc(msg)}</div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
    </div>
    <span class="tbar"></span>`;
  root.appendChild(el);
  while (root.children.length > 3) root.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 2600);
}

function confetti(n = 60) {
  const colors = ['#7c6cff', '#17cda8', '#ffb454', '#ff6b81', '#38bdf8', '#a855f7'];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw';
    c.style.background = colors[(Math.random() * colors.length) | 0];
    c.style.animationDuration = 1.6 + Math.random() * 1.4 + 's';
    c.style.animationDelay = Math.random() * 0.4 + 's';
    c.style.opacity = 0.75 + Math.random() * 0.25;
    $('#fx-root').appendChild(c);
    setTimeout(() => c.remove(), 3400);
  }
}

function rewardFloat(x, y, text) {
  const el = document.createElement('div');
  el.className = 'reward-float';
  el.textContent = text;
  el.style.left = x - 30 + 'px';
  el.style.top = y - 20 + 'px';
  $('#fx-root').appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

function confirmDialog(title, desc) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="width:380px">
        <h2>${esc(title)}</h2>
        <p style="font-size:13px;color:var(--text-2);line-height:1.6">${esc(desc)}</p>
        <div class="form-foot">
          <button class="btn ghost" data-r="0">取消</button>
          <button class="btn" style="background:linear-gradient(135deg,#ff9d5c,#ff6b81);box-shadow:0 6px 16px rgba(255,107,129,.3)" data-r="1">确定</button>
        </div>
      </div>`;
    mask.addEventListener('click', (e) => {
      const r = e.target.closest('[data-r]')?.dataset.r;
      if (r !== undefined) {
        mask.remove();
        resolve(r === '1');
      } else if (e.target === mask) {
        mask.remove();
        resolve(false);
      }
    });
    $('#modal-root').appendChild(mask);
  });
}

/* 多选一弹窗：返回选项下标，点遮罩返回 -1 */
function chooseDialog(title, desc, options) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="width:400px">
        <h2>${esc(title)}</h2>
        <p style="font-size:13px;color:var(--text-2);line-height:1.6;white-space:pre-wrap">${esc(desc)}</p>
        <div class="form-foot" style="flex-wrap:wrap;gap:8px">
          ${options.map((o, i) => `<button class="btn ${o.ghost ? 'ghost' : ''}" data-o="${i}">${esc(o.label)}</button>`).join('')}
        </div>
      </div>`;
    mask.addEventListener('click', (e) => {
      const k = e.target.closest('[data-o]')?.dataset.o;
      if (k !== undefined) {
        mask.remove();
        resolve(Number(k));
      } else if (e.target === mask) {
        mask.remove();
        resolve(-1);
      }
    });
    $('#modal-root').appendChild(mask);
  });
}

/* ================= 视图：今日 ================= */

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function renderToday() {
  const done = state.todayPlans.filter((p) => p.status === 'done').length;
  const total = state.todayPlans.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const C = 2 * Math.PI * 48;

  const dt = new Date();
  const dateStr = `${dt.getMonth() + 1}月${dt.getDate()}日 · 星期${DAYS[dt.getDay()]}`;

  const normalPlans = state.todayPlans.filter((p) => !p.contract);
  const contractPlans = state.todayPlans.filter((p) => p.contract);
  const projects = state.contractProjects || [];

  const tlItem = (p, i, extra = '') => `
    <div class="tl-item ${p.status === 'done' ? 'done' : ''} ${extra}" style="animation-delay:${i * 45}ms">
      <div class="tl-time"><div class="t">${p.when === 'boot' ? '🚀' : esc(p.time)}</div><div class="d">${p.when === 'boot' ? '开机时' : '提醒'}</div></div>
      <div class="tl-ico" style="background:${hexBg(COLORS[p.color] || COLORS.mint)}">${esc(p.icon)}</div>
      <div class="tl-main">
        <div class="tl-title">${esc(p.title)} <span class="pts">+${p.points}</span></div>
        <div class="tl-desc">${esc(p.desc || '无备注')}</div>
      </div>
      <div class="tl-actions">${actionHtml(p)}</div>
    </div>`;

  const normalHtml = normalPlans.length
    ? normalPlans.map((p, i) => tlItem(p, i)).join('')
    : '<div class="empty" style="padding:14px"><p>今天没有普通计划</p></div>';

  const contractHtml = contractPlans.length
    ? projects
        .map((c) => {
          const tasks = contractPlans.filter((p) => p.contract === c.id);
          if (!tasks.length) return '';
          return `
      <div class="cp-block">
        <div class="cp-head">
          <div class="cp-name">🤝 ${esc(c.title)}${c.expired ? '<span class="cp-tag">已到期</span>' : `<span class="cp-tag live">第 ${c.dayIndex}/${c.days} 天</span>`}</div>
          <span class="cp-meta">今日 ${c.todayDone}/${c.todayCount}${c.noTaskToday ? ' · 今日无任务，不扣钱' : (c.todayOwe ? ` · 今日应扣 ¥${c.todayOwe}` : ' · 今日全做完，不扣钱')} · 累计应扣 ¥${c.oweTotal}</span>
          ${(() => {
            const w = state.witness && state.witness[c.id];
            return w
              ? `<span class="cp-witness">👤 见证人 ${esc(w.name)} <button class="link-btn" data-witnesscard="${c.id}">生成见证卡</button></span>`
              : '';
          })()}
          <div class="cp-barwrap">
            <div class="bar cp-bar"><div class="bar-fill" style="width:${c.progressPct}%"></div></div>
            <span class="cp-pct">${c.progressPct}%</span>
          </div>
        </div>
        ${tasks.map((p, i) => tlItem(p, i, 'contract')).join('')}
      </div>`;
        })
        .join('')
    : '<div class="empty" style="padding:14px"><p>今天没有契约任务。在「目标 → 契约项目」里创建项目和子任务。</p></div>';

  const missedCount = state.todayPlans.filter((p) => p.status === 'missed').length;
  const cy = state.contractYesterday;
  const yBanner =
    cy && cy.total > 0
      ? `<div class="cp-yesterday">💰 昨日（${cy.date.slice(5)}）契约结算：应扣 <b>¥${cy.total}</b>${cy.items
          .map((i) => ` · ${esc(i.title)} ${i.pct}%（¥${i.owe}${i.paid ? ' · 已交' : ' · 待交'}）`)
          .join('')}</div>`
      : '';

  const micro = state.micro || {};
  const isWeekend = [0, 6].includes(new Date().getDay());
  const weekendHtml = isWeekend
    ? '<div class="nudge-banner weekend-banner">⚡ 限时挑战 · 周末双倍：今天打卡的积分（含连续加成）翻倍</div>'
    : '';
  const microHtml = micro.active
    ? `
    <div class="panel micro-card">
      <div class="micro-head">
        <div>
          <h3 style="margin:0">🪜 今天只做这些，就够</h3>
          <div class="micro-sub">现在欠 <b>${Math.abs(micro.points)}</b> 分。不要求你今天回到正分——每完成一条，负分就往回收 <b>${micro.gain}</b> 分。</div>
        </div>
        <div class="micro-score">${micro.done}/${micro.total}</div>
      </div>
      ${micro.steps
        .map(
          (s) => `
        <div class="micro-step ${s.done ? 'done' : ''}">
          <span class="ms-ico">${s.done ? '✓' : '○'}</span>
          <span class="ms-text">${esc(s.text)}</span>
          <span class="ms-gain">+${s.gain}</span>
          ${s.done ? '<span class="ms-done">已算过</span>' : `<button class="btn small" data-micro="${s.key}">现在做</button>`}
        </div>`
        )
        .join('')}
      <div class="ms-foot">不用等到明天，完成立刻回升。</div>
    </div>`
    : '';

  $('#view').innerHTML = `
    <div class="view-head">
      <div class="view-title">${greeting()} 👋</div>
      <div class="view-sub">${dateStr}${total ? ` · 今天还有 ${total - done} 项待完成` : ' · 今天没有安排，去「计划」里添加一个吧'}</div>
    </div>

    ${missedCount ? `<div class="nudge-banner">别让昨天的努力白费 💪 今天有 ${missedCount} 项已错过，去补卡吧</div>` : ''}
    ${yBanner}
    ${microHtml}
    ${weekendHtml}

    ${
      total === 0
        ? `
      <div class="hero" style="justify-content:center">
        <div class="empty" style="padding:30px 20px">
          <div class="big">🗓️</div>
          <p>今天还没有任何计划，设计你的第一个计划，开始积累积分吧。</p>
          <button class="btn" id="empty-add">＋ 新建计划</button>
        </div>
      </div>`
        : `
      <div class="hero">
        <div class="ring-wrap">
          <svg width="116" height="116">
            <defs>
              <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#7c6cff"/><stop offset="100%" stop-color="#17cda8"/>
              </linearGradient>
            </defs>
            <circle class="ring-bg" cx="58" cy="58" r="48" fill="none" stroke-width="9"/>
            <circle class="ring-fill" cx="58" cy="58" r="48" fill="none" stroke-width="9"
              stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}"/>
          </svg>
          <div class="ring-center">
            <div><div class="ring-num">${done}<span style="font-size:14px;color:var(--text-3)">/${total}</span></div>
            <div class="ring-cap">完成 ${pct}%</div></div>
          </div>
        </div>
        <div class="hero-stats">
          <div class="stat-chip hot"><span class="k">🔥 ${state.profile.streak}</span><span class="l">连续打卡（天）</span></div>
          <div class="stat-chip gain"><span class="k">+${state.todayPoints}</span><span class="l">今日积分</span></div>
          <div class="stat-chip"><span class="k">${state.profile.points}</span><span class="l">总积分</span></div>
        </div>
        ${state.todayBonus ? '<div class="hero-bonus">🎁 今日全勤 +30 已达成</div>' : ''}
      </div>
      <div class="section-head"><div class="section-title">今日三件事</div></div>
      <div class="panel mit-panel" id="mit-panel"></div>

      <div class="section-head"><div class="section-title">📋 普通任务</div></div>
      ${normalHtml}

      <div class="section-head"><div class="section-title">🤝 契约任务</div></div>
      ${contractHtml}

      <div class="section-head"><div class="section-title">每日小结</div></div>
      <div class="panel">
        <div class="diary-row">
          <select class="select" id="diary-mood">
            ${['', '精力充沛', '状态不错', '一般', '疲惫', '状态差'].map((m) => `<option value="${m}" ${(state.diaryToday?.mood || '') === m ? 'selected' : ''}>${m || '选择今日状态'}</option>`).join('')}
          </select>
          <input class="input" id="diary-text" maxlength="300" placeholder="一句话记录今天感受（可选）" value="${esc(state.diaryToday?.text || '')}" />
          <button class="btn small" id="diary-save">保存</button>
        </div>
      </div>
      `
    }
  `;

  const addBtn = $('#empty-add');
  if (addBtn) addBtn.onclick = () => openPlanForm();
  bindTodayActions();
  renderMits();
}

function renderMits() {
  const panel = $('#mit-panel');
  if (!panel) return;
  const mits = state.mits || [];
  const doneN = mits.filter((m) => m.done).length;
  panel.innerHTML = `
    <div class="mit-list">
      ${mits.length
        ? mits
            .map(
              (m) => `
        <div class="mit-item ${m.done ? 'done' : ''}">
          <span class="mit-check" data-mit="${m.id}">${m.done ? '✓' : ''}</span>
          <span class="mit-text">${esc(m.text)}</span>
          ${m.done ? '<span class="mit-pts">+10</span>' : ''}
          <button class="icon-btn del" data-mitdel="${m.id}" title="删除">✕</button>
        </div>`
            )
            .join('')
        : '<div class="mit-empty">写下今天最重要的 3 件事，完成一件 +10 积分</div>'}
    </div>
    ${
      mits.length < 3
        ? `<div class="mit-addrow">
            <input class="input" id="mit-input" maxlength="40" placeholder="如：写完实验报告第一章"/>
            <button class="btn" id="mit-add">＋ 添加</button>
          </div>`
        : `<div class="mit-full">已完成 ${doneN}/3</div>`
    }
  `;
  $('#mit-add') && ($('#mit-add').onclick = async () => {
    const v = $('#mit-input').value.trim();
    if (!v) return;
    const r = await api.mitAdd(v);
    if (!r.ok) toast(r.message, '', true);
  });
  $('#mit-input') && ($('#mit-input').onkeydown = (e) => e.key === 'Enter' && $('#mit-add').click());
  $$('[data-mit]').forEach((el) => (el.onclick = () => api.mitToggle(el.dataset.mit)));
  $$('[data-mitdel]').forEach((el) => (el.onclick = () => api.mitDelete(el.dataset.mitdel)));
}

function actionHtml(p) {
  if (p.status === 'done') {
    return `<span class="done-pill">✓ 已完成 +${p.earned}<button class="undo" data-undo="${p.id}">撤销</button></span>`;
  }
  if (p.status === 'awaiting') {
    return `<span class="miss-tag" style="color:var(--amber)">⏳ 已打卡 · 待验证</span><button class="btn small" data-verify="${p.id}">验证</button>`;
  }
  if (p.status === 'missed') {
    return `<span class="miss-tag">已错过窗口</span><button class="btn small ghost" data-makeup="${p.id}" data-title="${esc(p.title)}">补卡</button>`;
  }
  return `<button class="btn" data-checkin="${p.id}">打卡</button>`;
}

function bindTodayActions() {
  $$('#view [data-witnesscard]').forEach((btn) => {
    btn.onclick = async () => {
      const c = (state.contractProjects || []).find((x) => x.id === btn.dataset.witnesscard);
      const w = state.witness && state.witness[c && c.id];
      if (!c) return;
      const text =
        `我给自己立了个契约：「${c.title}」，${c.days} 天，每天没做完按完成度扣钱（最高 ¥${c.stake}/天）。\n` +
        `你是我的见证人${w ? '（' + w.name + '）' : ''}——你什么都不用做，只要知道这件事就够了。\n` +
        `${c.start} 开始，${c.endDate || ''} 到期。`;
      try {
        await navigator.clipboard.writeText(text);
        toast('见证卡已复制', '自己发给对方即可，App 不会替你发任何消息');
      } catch (e) {
        toast('复制失败', text, true);
      }
    };
  });
  $$('#view [data-micro]').forEach((btn) => {
    btn.onclick = async () => {
      const r = await api.microComplete(btn.dataset.micro);
      if (!r || !r.ok) return toast(r?.message || '这一步暂时不能算', '', true);
      confetti(40);
      if (window.PQAlly) {
        window.PQAlly.card('praise', {
          title: `微目标 +${r.gain}`,
          body: `${r.message}\n现在的积分：${r.points}`,
          mood: 'fired',
        });
      } else toast(`离正分又近了 ${r.gain} 分`, r.message);
      api.getState().then((s) => ((state = s), renderToday()));
    };
  });
  $$('#view [data-checkin]').forEach((btn) => {
    btn.onclick = async (e) => {
      const res = await api.checkin(btn.dataset.checkin);
      // 需密码确认的计划：先记为待验证，稍后点「验证」输守护密码才算完成
      if (res.pending) {
        toast('⏳ 已打卡 · 待验证', '点旁边的「验证」输入守护密码后完成');
        api.getState().then((s) => ((state = s), renderToday()));
        return;
      }
      if (res.ok) {
        celebrate(e.clientX, e.clientY, res);
      } else {
        toast(res.message || '打卡失败', '', true);
      }
    };
  });
  $$('#view [data-verify]').forEach((btn) => {
    btn.onclick = async (e) => {
      const plan = (state.plans || []).find((p) => p.id === btn.dataset.verify);
      const pw = await askPassword(`验证「${plan?.title || '该计划'}」已完成`);
      if (pw === null) return;
      const res = await api.checkin(btn.dataset.verify, pw);
      if (res.ok) {
        celebrate(e.clientX, e.clientY, res);
        api.getState().then((s) => ((state = s), renderToday()));
      } else {
        toast('密码不对', '验证未通过，仍是待验证状态', true);
      }
    };
  });
  $$('#view [data-makeup]').forEach((btn) => {
    btn.onclick = () => openMakeupDialog(btn.dataset.makeup, btn.dataset.title);
  });
  $$('#view [data-undo]').forEach((btn) => {
    btn.onclick = async () => {
      const ok = await confirmDialog('撤销打卡？', '将退回本次打卡获得的积分（含全勤奖励）。');
      if (ok) await api.undoCheckin(btn.dataset.undo);
    };
  });
  bindDiary();
}

/* 补卡弹窗：每月限 3 次，需填写理由 */
function openMakeupDialog(planId, title) {
  const left = 3 - (state.makeupUsed || 0);
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="max-width:420px">
      <h3>🔁 补卡 · ${esc(title)}</h3>
      <p class="modal-sub">每月限 3 次，本月剩余 <b style="color:var(--amber)">${Math.max(0, left)}</b> 次，补卡获得一半积分。</p>
      <textarea class="input" id="mk-reason" rows="3" maxlength="100" placeholder="补卡理由，如：昨晚临时加班，今早补上前天的锻炼"></textarea>
      <div class="modal-btns">
        <button class="btn ghost" id="mk-cancel">取消</button>
        <button class="btn" id="mk-ok">确认补卡</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  $('#mk-cancel', mask).onclick = () => mask.remove();
  $('#mk-ok', mask).onclick = async () => {
    const r = await api.makeupAdd({ date: new Date().toISOString().slice(0, 10), planId, reason: $('#mk-reason', mask).value });
    if (r.ok) {
      mask.remove();
      toast('补卡成功', `获得 ${r.gained} 积分 · 本月还剩 ${r.left} 次`);
    } else {
      toast(r.message || '补卡失败', '', true);
    }
  };
  setTimeout(() => $('#mk-reason', mask).focus(), 50);
}

/* 每日小结 */
function bindDiary() {
  const save = $('#diary-save');
  if (!save) return;
  save.onclick = async () => {
    const mood = $('#diary-mood')?.value || '';
    const text = $('#diary-text')?.value || '';
    await api.diarySave({ mood, text });
    toast('今日小结已记录', mood ? `状态：${mood}` : '');
  };
}

function celebrate(x, y, res) {
  confetti(res.perfectBonus ? 110 : 55);
  rewardFloat(x, y, `+${res.gained}`);
  // 有温度的反馈：不再只弹「+20 分」，交给盟友「阿刺」说一句人话
  // （同时明确报出分值构成；不编造「超过 80% 用户」这类没有数据支撑的话）
  if (window.PQAlly) window.PQAlly.praise(res);
  else toast('太棒了！今天也是自律的一天！', `+${res.gained} 分`);
  if (res.micro && res.micro.ok) {
    setTimeout(() => {
      if (window.PQAlly) window.PQAlly.card('praise', { title: '微目标达成', body: res.micro.message, mood: 'fired' });
    }, 900);
  }
}

/* ================= 视图：计划 ================= */

function renderPlans() {
  // 负分（名单升级）期间：计划放行的普通进程（不在白名单里的）全部被禁用
  const wl = (state.guard?.whitelist || []).map((x) => String(x).toLowerCase().replace(/\.exe$/, ''));
  const procBlocked = (p) => {
    if (!state.guard?.escalated) return false;
    const procs = p.allowProcs || [];
    return procs.some((n) => !wl.includes(String(n).toLowerCase().replace(/\.exe$/, '')));
  };
  const cards = state.plans
    .map((p, i) => {
      const blocked = procBlocked(p);
      const proj = p.contract ? (state.contractProjects || []).find((c) => c.id === p.contract) : null;
      const locked = !!(proj && !proj.expired);
      // 契约任务创建后不可修改：编辑与停用入口一律收起（到期后也一样，只能删）
      const immutable = !!p.contract;
      return `
    <div class="plan-card ${p.enabled ? '' : 'off'} ${p.contract ? 'is-contract' : ''}" style="animation-delay:${i * 40}ms">
      <div class="pc-top">
        <div class="pc-ico" style="background:${hexBg(COLORS[p.color] || COLORS.mint)}">${esc(p.icon)}</div>
        <div style="flex:1;min-width:0">
          <div class="pc-title">${esc(p.title)} ${p.contract ? '<span class="cp-tag">🤝 契约</span>' : ''}</div>
          <div class="pc-desc">${esc(p.desc || '')}</div>
        </div>
        ${immutable
          ? '<span class="cp-tag" title="契约任务创建后不可修改，也不能停用">🔒 不可改</span>'
          : `<div class="switch ${p.enabled ? 'on' : ''}" data-toggle="${p.id}" title="${p.enabled ? '启用中' : '已停用'}"></div>`}
      </div>
      <div class="pc-meta">
        <span class="pc-chip time">${p.when === 'boot' ? '🚀 开机时' : `⏰ ${esc(p.time)}`}</span>
        ${p.temp ? '<span class="pc-chip accent" title="灰名单兑换的临时计划，明天自动删除，打卡不计积分">⏳ 临时放行</span>' : `<span class="pc-chip accent">+${p.points} 积分</span>`}
        ${p.contract ? `<span class="pc-chip gold" title="契约项目：${esc(proj?.title || '')}">📁 ${esc(proj?.title || '契约项目')}</span>` : ''}
        ${(p.allowProcs || []).length ? `<span class="pc-chip" title="计划时段内放行，累计不超过 1 小时">🧩 ${esc(p.allowProcs.join('、'))}</span>` : ''}
        ${blocked ? '<span class="pc-chip" style="color:var(--danger);border-color:var(--danger)" title="积分为负（名单升级）期间，放行的普通进程全部禁用；转正后自动恢复">⛔ 负分期间放行已禁用</span>' : ''}
      </div>
      <div class="pc-days">
        ${DAYS.map((d, idx) => `<span class="pc-day ${(p.days || []).includes(idx) ? 'on' : ''}">${d}</span>`).join('')}
      </div>
      <div class="pc-foot">
        <span class="pc-chip">${p.contract ? `契约任务 · ${proj ? (proj.expired ? `已到期（${proj.endDate}）` : `${proj.endDate} 到期，此前不可删除`) : ''} · 创建不扣积分 · 创建后不可修改` : p.temp ? '时段结束后失效 · 明天自动删除' : p.when === 'boot' ? '打开应用时自动弹窗提醒' : p.enabled ? '到点自动弹窗提醒' : '提醒已关闭'}</span>
        <div class="pc-ops">
          ${immutable ? '<span class="cp-tag" title="契约任务创建后不可修改">🔒 不可改</span>' : `<button class="icon-btn" data-edit="${p.id}" title="编辑">✏️</button>`}
          ${locked ? '<span class="cp-tag" title="契约未到期，任务不可删除">🔒 不可删</span>' : `<button class="icon-btn del" data-del="${p.id}" title="删除">🗑️</button>`}
        </div>
      </div>
    </div>`;
    })
    .join('');

  $('#view').innerHTML = `
    <div class="view-head">
      <div class="view-title">我的计划</div>
      <div class="view-sub">共 ${state.plans.length} 个计划 · 启用 ${state.plans.filter((p) => p.enabled).length} 个</div>
    </div>
    <div class="section-head">
      <div class="section-title">全部计划</div>
      <button class="btn" id="add-plan">＋ 新建计划</button>
    </div>
    ${state.plans.length ? `<div class="plan-grid">${cards}</div>` : `
      <div class="empty"><div class="big">✨</div><p>还没有计划。设计计划 → 设置提醒时间 → 到点弹窗打卡拿奖励。</p>
      <button class="btn" id="empty-add2">＋ 新建计划</button></div>`}
  `;

  $('#add-plan') && ($('#add-plan').onclick = () => openPlanForm());
  $('#empty-add2') && ($('#empty-add2').onclick = () => openPlanForm());

  $$('[data-toggle]').forEach((el) => {
    el.onclick = async () => {
      const turningOff = el.classList.contains('on');
      const ok = turningOff
        ? await confirmDialog('暂停这个计划？', '暂停后当天不再提醒。暂停不扣积分。')
        : await confirmDialog('重新启用这个计划？', '启用后恢复提醒。重新启用不扣积分。');
      if (!ok) return;
      const res = await api.togglePlan(el.dataset.toggle, !turningOff);
      toast(
        turningOff ? '计划已暂停' : '计划已重新启用',
        res && res.deducted ? `已扣除 ${res.deducted} 积分` : ''
      );
    };
  });
  $$('[data-edit]').forEach((el) => {
    el.onclick = () => openPlanForm(state.plans.find((p) => p.id === el.dataset.edit));
  });
    $$('[data-del]').forEach((el) => {
    el.onclick = async () => {
      const p = state.plans.find((x) => x.id === el.dataset.del);
      const ok = await confirmDialog(
        `删除「${p.title}」？`,
        '删除后该计划的历史打卡记录会保留，但不再提醒。删除不扣积分。'
      );
      if (!ok) return;
      let res = await api.deletePlan(p.id);
      if (res && res.needPassword) {
        const pw = await askPassword('删除计划需要验证');
        if (pw === null) return;
        res = await api.deletePlan({ id: p.id, password: pw });
        if (res.needPassword) return toast('密码不对', '', true);
      }
      if (res && res.ok) {
        toast('计划已删除', res.deducted ? `已扣除 ${res.deducted} 积分` : '');
      } else if (res && res.message) {
        toast(res.message, '', true);
      }
    };
  });
}

function hexBg(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `linear-gradient(135deg, rgba(${r},${g},${b},0.22), rgba(${r},${g},${b},0.10))`;
}

/* ---------- 计划表单 ---------- */

let draft = null;

function openPlanForm(plan, contractId) {
  // 契约任务创建后不可修改：任何路径试图编辑都直接挡回（主进程还有第二道）
  if (plan && plan.contract) {
    toast('🔒 契约任务创建后不可修改', '立下的约不能随手涂改；到期后可删除重建。', true);
    return;
  }
  draft = plan
    ? { ...plan, days: [...(plan.days || [])], needConfirm: !!plan.needConfirm, when: plan.when || 'time' }
    : {
        id: null,
        title: '',
        desc: '',
        icon: '🎯',
        color: 'indigo',
        time: '09:00',
        when: 'time',
        days: [1, 2, 3, 4, 5],
        points: 20,
        allowProcs: [],
        needConfirm: false,
        enabled: true,
      };
  const contract = contractId || draft.contract || null;
  draft.contract = contract;
  const contractProj = contract ? (state.contractProjects || []).find((c) => c.id === contract) : null;

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.id = 'plan-modal';
  mask.innerHTML = `
    <div class="modal">
      <h2>${contract ? `🤝 新建契约任务${contractProj ? ` · ${esc(contractProj.title)}` : ''}` : plan ? '编辑计划' : '新建计划'}</h2>
      ${contract ? '<div class="form-hint" style="margin-bottom:6px;color:var(--amber)">契约任务：创建不扣积分，设置和普通计划一样；出现在「今日」带金边。⚠️ 一旦创建就不可修改、不可停用，到期前也不可删除——想清楚再点保存。</div>' : ''}
      <div class="form-row">
        <label class="form-label">计划名称</label>
        <input class="input" id="f-title" maxlength="30" placeholder="例如：晨间阅读" value="${esc(draft.title)}"/>
      </div>
      <div class="form-row">
        <label class="form-label">备注（可选）</label>
        <textarea class="textarea" id="f-desc" maxlength="120" placeholder="具体要做什么？">${esc(draft.desc)}</textarea>
      </div>
      <div class="form-row">
        <label class="form-label">图标</label>
        <div class="emoji-row" id="f-emoji">
          ${EMOJIS.map((e) => `<button class="emoji-opt ${e === draft.icon ? 'sel' : ''}" data-v="${e}">${e}</button>`).join('')}
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">颜色</label>
        <div class="color-row" id="f-color">
          ${Object.entries(COLORS)
            .map(([k, v]) => `<button class="color-opt ${k === draft.color ? 'sel' : ''}" data-v="${k}" style="background:${v}"></button>`)
            .join('')}
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">触发时机</label>
        <div class="day-picker" id="f-when">
          <button class="day-opt ${draft.when !== 'boot' ? 'sel' : ''}" data-v="time">⏰ 定时时间</button>
          <button class="day-opt ${draft.when === 'boot' ? 'sel' : ''}" data-v="boot">🚀 开机时</button>
        </div>
        <div class="form-hint">选「开机时」：每次打开应用（含开机自启）就自动弹窗提醒，不需要固定时间。</div>
      </div>
      <div class="form-row" style="display:flex;gap:14px">
        <div style="flex:1">
          <label class="form-label">提醒时间</label>
          <input type="time" class="input" id="f-time" value="${esc(draft.time)}" ${draft.when === 'boot' ? 'disabled style="opacity:.4"' : ''}/>
        </div>
        <div style="flex:1">
          <label class="form-label">打卡积分（5~200）</label>
          <input type="number" class="input" id="f-points" min="5" max="200" value="${draft.points}"/>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">重复日期</label>
        <div class="day-picker" id="f-days">
          ${DAYS.map((d, idx) => `<button class="day-opt ${draft.days.includes(idx) ? 'sel' : ''}" data-v="${idx}">${d}</button>`).join('')}
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">完成确认</label>
        <div class="day-picker" id="f-confirm">
          <button class="day-opt ${draft.needConfirm ? 'sel' : ''}" data-v="1">🔒 需密码确认</button>
        </div>
        <div class="form-hint">开启后，打卡先记为「待验证」；要真正完成、拿到积分，必须在主界面输入守护密码验证——防止“顺手点掉”。</div>
      </div>
      <div class="form-row">
        <label class="form-label">计划内需要的软件（可选）</label>
        <select class="select" id="f-procs-pick" style="margin-bottom:8px">
          <option value="">从运行中的进程选择…</option>
        </select>
        <input class="input" id="f-procs" maxlength="120" placeholder="例如：chrome, wechat, vscode（逗号分隔）"
          value="${esc((draft.allowProcs || []).join(', '))}"/>
        <div class="form-hint">
          计划时段内放行这些软件，累计使用不超过 <b>1 小时</b>；用满后按普通软件处理。<br/>
          不能与黑名单 / 灰名单重叠，重叠的会被自动剔除。<br/>
          只有这里<b>新增非白名单普通软件</b>时才扣 10 积分；改标题、时间、星期不扣分。
        </div>
      </div>
      <div class="form-foot">
        <button class="btn ghost" id="f-cancel">取消</button>
        <button class="btn" id="f-save">${contract ? '创建契约任务' : '保存'}</button>
      </div>
    </div>`;

  $('#modal-root').appendChild(mask);

  const pick = (sel, attr) => {
    $$(sel + ' [data-v]', mask).forEach((b) => {
      b.onclick = () => {
        if (attr === 'days') {
          b.classList.toggle('sel');
        } else {
          $$(sel + ' .sel', mask).forEach((x) => x.classList.remove('sel'));
          b.classList.add('sel');
        }
      };
    });
  };
  pick('#f-emoji');
  pick('#f-color');
  // 触发时机：切到「开机时」时禁用时间输入
  pick('#f-when');
  $$('#f-when [data-v]', mask).forEach((b) => {
    b.onclick = () => {
      $$('#f-when .sel', mask).forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      const t = $('#f-time', mask);
      if (t) {
        if (b.dataset.v === 'boot') {
          t.setAttribute('disabled', '');
          t.style.opacity = '.4';
        } else {
          t.removeAttribute('disabled');
          t.style.opacity = '';
        }
      }
    };
  });
  // 星期是"多选开关"：点一次亮、再点一次灭，必须传 'days' 走 toggle 分支
  pick('#f-days', 'days');
  pick('#f-confirm', 'days');

  $('#f-cancel', mask).onclick = () => mask.remove();
  // 从运行中的进程里挑选，避免手动打错名字
  (async () => {
    try {
      const procs = await api.guardProcesses();
      const sel = $('#f-procs-pick', mask);
      if (!sel || !procs) return;
      sel.innerHTML =
        '<option value="">从运行中的进程选择…</option>' +
        procs.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
      sel.onchange = () => {
        const v = sel.value;
        if (!v) return;
        const input = $('#f-procs', mask);
        const cur = (input.value || '').split(/[,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
        if (!cur.some((x) => x.toLowerCase() === v.toLowerCase())) cur.push(v);
        input.value = cur.join(', ');
        sel.value = '';
      };
    } catch (_) {}
  })();
  mask.addEventListener('keydown', (e) => e.key === 'Escape' && mask.remove());
  mask.addEventListener('click', (e) => e.target === mask && mask.remove());
  $('#f-title', mask).focus();

  $('#f-save', mask).onclick = async () => {
    const title = $('#f-title', mask).value.trim();
    if (!title) {
      toast('请填写计划名称', '', true);
      $('#f-title', mask).focus();
      return;
    }
    const days = $$('#f-days .sel', mask).map((b) => Number(b.dataset.v));
    if (!days.length) {
      toast('至少选择一个重复日期', '', true);
      return;
    }
    const allowProcs = ($('#f-procs', mask).value || '')
      .split(/[,，;；\s]+/)
      .map((x) => x.trim().replace(/\.exe$/i, ''))
      .filter(Boolean)
      .slice(0, 12);
    const when = $('#f-when .sel', mask)?.dataset.v === 'boot' ? 'boot' : 'time';
    const planPayload = {
      id: draft.id || undefined,
      title,
      desc: $('#f-desc', mask).value.trim(),
      icon: $('#f-emoji .sel', mask)?.dataset.v || '🎯',
      color: $('#f-color .sel', mask)?.dataset.v || 'indigo',
      when,
      time: when === 'boot' ? (draft.time || '09:00') : $('#f-time', mask).value || '09:00',
      points: Number($('#f-points', mask).value) || 20,
      days,
      needConfirm: !!$('#f-confirm .sel', mask),
      allowProcs,
      enabled: draft.enabled,
      contract: draft.contract || undefined,
      createdAt: draft.createdAt,
    };
    let res = await api.savePlan({ plan: planPayload });
    if (res.needPassword) {
      const pw = await askPassword('更改计划需要验证');
      if (pw === null) return;
      res = await api.savePlan({ plan: planPayload, password: pw });
      if (res.needPassword) return toast('密码不对', '', true);
    }
    if (!res.ok) return toast(res.message || '保存失败', '', true);
    mask.remove();
    const deducted = Number(res.deducted) || 0;
    const procNote = (res.normalProcs || []).join('、');
    const rejected = res.rejected && res.rejected.length ? res.rejected : null;
    if (deducted) {
      // 计划里新放了非白名单普通软件 —— 这是唯一会扣分的计划操作
      toast(
        `${draft.id ? '计划已更新' : '计划已创建'}（-${deducted} 积分）`,
        `${procNote} 不是白名单软件，已计入计划放行项` +
          (rejected ? `；${rejected.join('、')} 在黑/灰名单里，已剔除` : '')
      );
    } else if (rejected) {
      toast('计划已保存，但部分软件被剔除', `${rejected.join('、')} 在黑名单或灰名单里，不能作为计划放行项`);
    } else if (draft.contract) {
      toast(draft.id ? '契约任务已更新' : '🤝 契约任务已创建', '不扣积分 · 会出现在「今日」（金边）· 项目到期前不可删除');
    } else {
      toast(draft.id ? '计划已更新' : '计划已创建', '到点会自动弹窗提醒（不扣积分）');
    }
  };
}

/* ================= 视图：自习房 ================= */

/* ---- 番茄钟引擎（视图切换不中断） ---- */
const pomo = {
  phase: 'idle', // idle | focus | break
  focusMin: 25,
  breakMin: 5,
  left: 0,
  total: 0,
  timer: null,
  cycleDone: 0,
};

function pomoLabel() {
  return { idle: '待开始', focus: '专注中', break: '休息中' }[pomo.phase];
}

function fmtMMSS(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function beep(times = 2) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0, ctx.currentTime + i * 0.35);
      g.gain.linearRampToValueAtTime(0.16, ctx.currentTime + i * 0.35 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.35 + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.35);
      o.stop(ctx.currentTime + i * 0.35 + 0.35);
    }
  } catch (_) {}
}

function pomoStart(mins) {
  if (pomo.phase === 'focus' || pomo.phase === 'break') return;
  if (mins) pomo.focusMin = mins;
  pomoEnter('focus');
}

/* 专注行为轨迹：只在专注期记录，用来判断「这一节算不算、有没有逃」
   不记内容、不记按键字符，只记次数与时间分布。 */
const pqTrace = {
  on: false,
  t0: 0,
  awayMs: 0,
  leaves: 0,
  swaps: 0,
  mouse: 0,
  keys: 0,
  focusMs: 0,
  blurAt: 0,
  buckets: [],
  bound: false,
  reset() {
    this.on = false;
    this.t0 = 0;
    this.awayMs = 0;
    this.leaves = 0;
    this.swaps = 0;
    this.mouse = 0;
    this.keys = 0;
    this.focusMs = 0;
    this.blurAt = 0;
    this.buckets = [];
  },
  bucket(now) {
    const i = Math.max(0, Math.floor((now - this.t0) / (5 * 60e3)));
    while (this.buckets.length <= i) this.buckets.push(0);
    this.buckets[i] += 1;
  },
  start() {
    this.reset();
    this.on = true;
    this.t0 = Date.now();
    this.bind();
  },
  bind() {
    if (this.bound) return;
    this.bound = true;
    const tickFocus = () => {
      if (!this.on) return;
      if (!this.blurAt && typeof document.hasFocus === 'function' && document.hasFocus()) this.focusMs += 5000;
    };
    setInterval(tickFocus, 5000);
    window.addEventListener('blur', () => {
      if (!this.on || this.blurAt) return;
      this.leaves += 1;
      this.swaps += 1;
      this.blurAt = Date.now();
    });
    window.addEventListener('focus', () => {
      if (!this.on) return;
      if (this.blurAt) {
        this.awayMs += Date.now() - this.blurAt;
        this.blurAt = 0;
      }
      this.swaps += 1;
    });
    window.addEventListener('mousemove', () => {
      if (!this.on) return;
      this.mouse += 1;
      this.bucket(Date.now());
    }, { passive: true });
    window.addEventListener('keydown', () => {
      if (!this.on) return;
      this.keys += 1;
      this.bucket(Date.now());
    });
  },
  finish(minutes) {
    if (this.blurAt) {
      this.awayMs += Date.now() - this.blurAt;
      this.blurAt = 0;
    }
    const payload = {
      minutes,
      awayMs: this.awayMs,
      leaves: this.leaves,
      guardHits: 0,
      buckets: this.buckets.slice(0, Math.ceil((minutes * 60e3) / (5 * 60e3))),
      focusMs: this.focusMs,
      mouseMoves: this.mouse,
      keyPresses: this.keys,
      windowSwitches: this.swaps,
    };
    this.reset();
    return payload;
  },
};

function pomoEnter(phase) {
  pomo.phase = phase;
  pomo.total = (phase === 'focus' ? pomo.focusMin : pomo.breakMin) * 60;
  pomo.left = pomo.total;
  /* 专注期开始记录失焦与输入分布；休息期不记（休息就该走开） */
  if (phase === 'focus') pqTrace.start();
  else pqTrace.reset();
  if (pomo.timer) clearInterval(pomo.timer);
  pomo.timer = setInterval(pomoTick, 1000);
  updatePomoUI();
  syncRoomState();
}

function pomoPause() {
  if (pomo.timer) {
    clearInterval(pomo.timer);
    pomo.timer = null;
  }
  pomo.paused = true;
  updatePomoUI();
}

function pomoResume() {
  if (pomo.phase === 'idle' || pomo.timer) return;
  pomo.paused = false;
  pomo.timer = setInterval(pomoTick, 1000);
  updatePomoUI();
}

function pomoAbort() {
  if (pomo.timer) {
    clearInterval(pomo.timer);
    pomo.timer = null;
  }
  pqTrace.reset();
  pomo.phase = 'idle';
  pomo.left = 0;
  pomo.paused = false;
  updatePomoUI();
  syncRoomState();
}

async function pomoTick() {
  pomo.left--;
  if (pomo.left <= 0) {
    if (pomo.timer) {
      clearInterval(pomo.timer);
      pomo.timer = null;
    }
    if (pomo.phase === 'focus') {
      beep(3);
      /* 先过纪律审：挂机刷时长 / 逃兵在这一步被拦下，通过才发积分 */
      let disc = null;
      const trace = pqTrace.finish(pomo.focusMin);
      if (api.discSession) {
        try {
          disc = await api.discSession(trace);
        } catch (_) {
          disc = null;
        }
      }
      if (disc && disc.voided) {
        toast('这一节不计分', (disc.messages && disc.messages[0]) || '检测到长时间没有操作，休息一下重新开始吧', true);
        pomoEnter('break');
        return;
      }
      const res = await api.focusComplete({ minutes: pomo.focusMin, kind: 'focus' });
      if (res.ok) {
        confetti(70);
        toast(`🍅 完成 1 个番茄（${res.minutes} 分钟）+${res.gained} 积分`, `今天第 ${res.pomodoros} 个番茄 · 休息一下`);
      }
      if (disc && disc.messages && disc.messages.length) {
        const msg = disc.messages[0];
        setTimeout(() => toast(disc.penalty ? `纪律提醒 · -${disc.penalty} 分` : '纪律提醒', msg, !!disc.penalty), 1200);
      }
      if (disc && disc.state && disc.state.frozen) {
        setTimeout(() => toast('军团资格已冻结', '连续打卡 3 天可以提前解冻，其他功能不受影响', true), 2400);
      }
      pomoEnter('break');
    } else {
      beep(1);
      toast('休息结束，开始下一轮专注吧 💪');
      pomoEnter('focus');
    }
    return;
  }
  updatePomoUI();
}

function updatePomoUI() {
  const t = $('#pomo-time');
  if (!t) return;
  t.textContent = pomo.left ? fmtMMSS(pomo.left) : fmtMMSS(pomo.focusMin * 60);
  const stage = $('#pomo-stage');
  stage.textContent = pomoLabel();
  stage.className = 'stage-tag ' + pomo.phase;

  const start = $('#pomo-start');
  const pause = $('#pomo-pause');
  const abort = $('#pomo-abort');
  if (start) start.style.display = pomo.phase === 'idle' ? '' : 'none';
  if (pause) pause.style.display = pomo.phase !== 'idle' ? '' : 'none';
  if (pause) pause.textContent = pomo.timer ? '暂停' : '继续';
  if (abort) abort.style.display = pomo.phase !== 'idle' ? '' : 'none';

  // 环形进度
  const total = pomo.total || pomo.focusMin * 60;
  const pct = total ? 1 - pomo.left / total : 0;
  const ring = $('#pomo-ring');
  if (ring) {
    const C = 2 * Math.PI * 84;
    ring.style.strokeDashoffset = C * (1 - pct);
  }
}

/* ---- 心跳监测 ---- */
let hr = null;
let hrOn = false;
let hrPushT = 0; // 上次向房间推送心跳的时间

async function hrToggle() {
  const video = $('#hr-video');
  if (!video) return;
  if (hrOn) {
    hr.stop();
    hrOn = false;
    $('#hr-toggle').textContent = '开启摄像头测心跳';
    $('#hr-overlay').style.display = '';
    drawWave([]);
    syncRoomState(); // 通知房间：摄像头已关
    return;
  }
  try {
    if (!hr) {
      hr = new window.HRMonitor();
      hr.onUpdate = (d) => {
        const bpmEl = $('#hr-bpm');
        if (!bpmEl) return;
        bpmEl.textContent = d.bpm || '--';
        const st = $('#hr-status');
        if (d.warming) {
          st.textContent = '正在测量，请保持不动，看向屏幕…';
          st.className = 'hr-status warming';
        } else if (d.bpm && d.quality > 0.45) {
          st.textContent = '信号良好';
          st.className = 'hr-status good';
        } else if (d.bpm) {
          st.textContent = '信号一般，光线充足更准';
          st.className = 'hr-status mid';
        } else {
          st.textContent = '检测中…';
          st.className = 'hr-status warming';
        }
        const q = $('#hr-quality');
        if (q) q.style.width = Math.round((d.quality || 0) * 100) + '%';
        drawWave(d.wave || []);
        // 房间内实时同步心跳（最快 2 秒一次）
        if (roomJoined && Date.now() - hrPushT > 2000) {
          hrPushT = Date.now();
          syncRoomState();
        }
      };
    }
    await hr.start(video);
    hrOn = true;
    $('#hr-toggle').textContent = '关闭摄像头';
    $('#hr-overlay').style.display = 'none';
  } catch (err) {
    toast('无法打开摄像头', '请检查权限与其他程序是否占用', true);
  }
}

function drawWave(wave) {
  const c = $('#hr-wave');
  if (!c) return;
  const ctx = c.getContext('2d');
  const W = (c.width = c.clientWidth * 2);
  const H = (c.height = 120);
  ctx.clearRect(0, 0, W, H);
  wave = wave || [];
  if (!wave.length) {
    ctx.fillStyle = 'rgba(128,132,170,0.4)';
    ctx.font = '22px sans-serif';
    ctx.fillText('等待信号…', W / 2 - 50, H / 2);
    return;
  }
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#7c6cff');
  grad.addColorStop(1, '#17cda8');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 3;
  ctx.beginPath();
  wave.forEach((v, i) => {
    const x = (i / (wave.length - 1)) * W;
    const y = H / 2 - v * H * 0.4;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

/* ---- 房间摄像头：自愿分享 ----
 * 自己开启后每 0.5 秒抓一帧（320x240 JPEG），经房主中继给全房间；
 * 收到别人的帧在画面条里显示，4 秒没新帧视为中断。退出房间自动关闭。 */
let camOn = false;
let camStream = null;
let camTimer = null;
let camFrames = new Map(); // memberId|'self' -> { url, at }

async function camToggle() {
  if (camOn) return camStop();
  if (!roomJoined) return toast('先加入或创建房间', '', true);
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 10 } },
      audio: false,
    });
    camOn = true;
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = camStream;
    try {
      await video.play();
    } catch (_) {}
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    camTimer = setInterval(() => {
      if (!camOn || !roomJoined) return camStop();
      try {
        if (video.readyState >= 2) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const url = canvas.toDataURL('image/jpeg', 0.5);
          camFrames.set('self', { url, at: Date.now() });
          api.roomCamFrame(url);
          updateCamFrames();
        }
      } catch (_) {}
    }, 500);
    syncRoomState();
    renderCamStrip();
    updateCamBtn();
    // 强制开启：摄像头一开就开始盯学
    if (window.AIWatch && !AIWatch.isRunning()) AIWatch.start(() => camStream);
    toast('📷 摄像头已共享', '房间成员能看到你的画面；AI 盯学已自动开启');
  } catch (err) {
    toast('无法打开摄像头', '请检查权限与其他程序是否占用', true);
  }
}

function camStop(silent) {
  const was = camOn;
  camOn = false;
  AIWatch.stop('', true); // AI 盯学依赖摄像头流，摄像头关则停
  if (camTimer) {
    clearInterval(camTimer);
    camTimer = null;
  }
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
  camFrames.delete('self');
  if (was) {
    syncRoomState();
    renderCamStrip();
    updateCamBtn();
    if (!silent) toast('摄像头已关闭', '房间内不再看到你的画面');
  }
}

function updateCamBtn() {
  const b = $('#cam-toggle');
  if (!b) return;
  b.textContent = camOn ? '⏹ 关闭摄像头共享' : '📷 开摄像头给房间看';
  b.classList.toggle('warm', camOn);
  b.classList.toggle('ghost', !camOn);
}

function renderCamStrip() {
  const strip = $('#cam-strip');
  if (!strip) return;
  let html = '';
  if (camOn) {
    html += `<div class="cam-tile" data-cam="self"><img alt="我"/><span class="cam-name">我（共享中）</span></div>`;
  }
  for (const m of roomMembers) {
    if (m.self) continue;
    html += `<div class="cam-tile" data-cam="${esc(m.id || m.name)}" style="display:none"><img alt=""/><span class="cam-name">${esc(m.name || '同学')}</span></div>`;
  }
  strip.innerHTML = html || '<div class="cam-empty">📷 还没有人开摄像头 · 点「开摄像头给房间看」自愿共享画面</div>';
  updateCamFrames();
}

/* ---- 共享画面全屏浮层：点缩略图放大，点任意处 / Esc 退出 ---- */
let picViewer = null;

function openFrameViewer(kind, key, title) {
  closeFrameViewer();
  const mask = document.createElement('div');
  mask.id = 'pic-viewer';
  /* 打开即整窗全屏 + 画面铺满整屏（cover，无黑边） */
  api.setFullscreen(true).then((before) => {
    if (picViewer && picViewer.timer === timer) picViewer.wasFull = !!before;
  });
  mask.style.cssText =
    'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:80;overflow:auto;cursor:zoom-out;display:flex;align-items:center;justify-content:center';
  mask.innerHTML = `
    <img id="pv-img" style="width:100%;height:100%;object-fit:cover;display:block" alt=""/>
    <div id="pv-tip" style="position:fixed;top:14px;left:18px;color:#cfe0f2;font-size:13px;
      background:rgba(10,14,22,.72);padding:7px 15px;border-radius:99px;transition:opacity .4s;
      border:1px solid rgba(120,150,190,.35)">🖥 ${esc(
        title
      )} · 已铺满整屏 · 双击切换 完整显示/原始像素 · 点击或 Esc 退出</div>`;
  const img = mask.querySelector('#pv-img');
  const tip = mask.querySelector('#pv-tip');
  /* 三态：cover 铺满（默认）→ contain 完整显示 → none 原始像素 */
  const MODES = ['cover', 'contain', 'none'];
  let mode = 0;
  const applyMode = () => {
    const m = MODES[mode];
    img.style.objectFit = m;
    img.style.width = m === 'none' ? 'auto' : '100%';
    img.style.height = m === 'none' ? 'auto' : '100%';
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    mask.style.cursor = m === 'none' ? 'zoom-in' : 'zoom-out';
    tip.textContent =
      m === 'cover'
        ? '🖥 已铺满整屏（双击切完整显示）'
        : m === 'contain'
          ? '🖥 完整显示（双击切原始像素）'
          : '🔍 原始像素，可拖动查看细节（双击还原铺满）';
    tip.style.opacity = '1';
    clearTimeout(tip._t);
    tip._t = setTimeout(() => (tip.style.opacity = '0'), 2600);
  };
  const update = () => {
    const f = (kind === 'scr' ? scrFrames : camFrames).get(key);
    if (!img || !mask.isConnected) return;
    if (f && Date.now() - f.at < 8000) {
      if (img.dataset.cur !== String(f.at)) {
        img.src = f.url;
        img.dataset.cur = String(f.at);
      }
      img.style.opacity = '1';
    } else {
      img.style.opacity = '0.35';
    }
  };
  update();
  const timer = setInterval(update, 250);
  const close = () => {
    clearInterval(timer);
    mask.remove();
    document.removeEventListener('keydown', onKey);
    if (picViewer && picViewer.timer === timer) {
      if (picViewer.wasFull === false) api.setFullscreen(false); // 之前不是全屏，退出时还原
      picViewer = null;
    }
  };
  /* 单击退出、双击切换缩放——220ms 延迟区分，避免双击时误关 */
  let clickTimer = null;
  mask.onclick = () => {
    if (clickTimer) return;
    clickTimer = setTimeout(() => {
      clickTimer = null;
      close();
    }, 220);
  };
  mask.ondblclick = (e) => {
    e.stopPropagation();
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    mode = (mode + 1) % MODES.length;
    applyMode();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  picViewer = { timer, onKey, close, wasFull: null };
  document.body.appendChild(mask);
  setTimeout(() => (tip.style.opacity = '0'), 3200);
}

function closeFrameViewer() {
  if (picViewer) {
    clearInterval(picViewer.timer);
    document.removeEventListener('keydown', picViewer.onKey);
    const m = document.getElementById('pic-viewer');
    if (m) m.remove();
    picViewer = null;
  }
}

function updateCamFrames() {
  const strip = $('#cam-strip');
  if (!strip) return;
  const now = Date.now();
  for (const tile of strip.querySelectorAll('.cam-tile[data-cam]')) {
    const key = tile.dataset.cam;
    const f = camFrames.get(key);
    const img = tile.querySelector('img');
    // 点缩略图 → 全屏查看
    tile.style.cursor = 'zoom-in';
    tile.onclick = () => openFrameViewer('cam', key, '摄像头画面' + (key === 'self' ? '（我）' : ''));
    if (f && now - f.at < 4000) {
      tile.style.display = '';
      if (img && img.dataset.cur !== String(f.at)) {
        img.src = f.url;
        img.dataset.cur = String(f.at);
      }
    } else if (key !== 'self') {
      tile.style.display = 'none';
    }
  }
}
setInterval(() => {
  if (roomJoined && $('#cam-strip')) updateCamFrames();
}, 1000);

/* ---- 房间屏幕共享：自愿共享 ----
 * 先从系统画面源里挑一个（整屏或某个窗口），经主进程一次性授权后抓流；
 * 每 1 秒抓一帧（宽 800 JPEG）经房主中继给全房间，收到别人的帧在屏幕条里显示，
 * 6 秒没有新帧视为已关闭。退出房间/换页自动关闭，别人无法强行看你屏幕。 */
let scrOn = false;
let scrStream = null;
let scrTimer = null;
let scrTitle = '';
let scrFrames = new Map(); // memberId|'self' -> { url, at }
let scrPickerOpen = false;

async function scrToggle() {
  if (scrOn) return scrStop();
  if (!roomJoined) return toast('先加入或创建房间', '', true);
  if (scrPickerOpen) return;
  const list = await api.screenSources();
  if (!Array.isArray(list) || !list.length) {
    return toast('没有可共享的画面', '系统没有返回屏幕或窗口列表', true);
  }
  showSourcePicker(list);
}

/* 画面源选择器：整屏排前面，窗口按名字排后面 */
function showSourcePicker(list) {
  scrPickerOpen = true;
  const screens = list.filter((s) => s.kind === 'screen');
  const wins = list.filter((s) => s.kind !== 'screen').slice(0, 12);
  const card = (s) => `
    <div class="src-card" data-id="${esc(s.id)}" data-name="${esc(s.name)}">
      ${s.thumb ? `<img src="${s.thumb}" alt=""/>` : '<div class="src-noimg">无预览</div>'}
      <div class="src-name">${s.kind === 'screen' ? '🖥 ' : '🪟 '}${esc(s.name)}</div>
    </div>`;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="width:640px">
      <h2>共享哪个画面给房间？</h2>
      <p style="font-size:13px;color:var(--text-2);line-height:1.6;margin-bottom:10px">
        选中的画面会以<strong>约 1 帧/秒的低清缩略图</strong>发给房间成员，随时可以点「停止共享」。
        你自己不点，没人能看到你的屏幕。
      </p>
      ${screens.length ? `<div class="src-sec">整个屏幕</div><div class="src-grid">${screens.map(card).join('')}</div>` : ''}
      ${wins.length ? `<div class="src-sec">某个窗口</div><div class="src-grid">${wins.map(card).join('')}</div>` : ''}
      <div class="form-foot">
        <button class="btn ghost" data-r="0">取消</button>
      </div>
    </div>`;
  mask.addEventListener('click', async (e) => {
    if (e.target.closest('[data-r="0"]') || e.target === mask) {
      mask.remove();
      scrPickerOpen = false;
      return;
    }
    const c = e.target.closest('.src-card');
    if (!c) return;
    const id = c.dataset.id;
    const name = c.dataset.name;
    mask.remove();
    scrPickerOpen = false;
    await scrStart(id, name);
  });
  $('#modal-root').appendChild(mask);
}

async function scrStart(id, name) {
  try {
    const pick = await api.screenPick(id);
    if (!pick || !pick.ok) return toast('无法共享这个画面', (pick && pick.msg) || '请重新选择', true);
    scrStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 10, max: 15 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (err) {
    scrStream = null;
    return toast('未能开始共享屏幕', '授权被拒绝或该窗口已关闭', true);
  }
  scrOn = true;
  scrTitle = name || '我的屏幕';
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = scrStream;
  try {
    await video.play();
  } catch (_) {}
  // 用户点系统的“停止共享”时同步收尾
  scrStream.getVideoTracks().forEach((t) => {
    t.onended = () => scrStop();
  });

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let busy = false;
  scrTimer = setInterval(() => {
    if (!scrOn || !roomJoined) return scrStop();
    if (busy || video.readyState < 2) return;
    try {
      const vw = video.videoWidth || 1600;
      const vh = video.videoHeight || 900;
      // 高清：最多 1600px 宽（保持原始比例），JPEG 质量 0.75，局域网 TCP 扛得住
      const w = Math.min(1600, vw);
      const h = Math.round((vh / vw) * w);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      busy = true;
      ctx.drawImage(video, 0, 0, w, h);
      const url = canvas.toDataURL('image/jpeg', 0.75);
      busy = false;
      if (url.length > 1500000) return; // 极端复杂画面（满屏碎图）才放弃这一帧
      scrFrames.set('self', { url, at: Date.now() });
      api.roomShareFrame(url);
      updateScrFrames();
    } catch (_) {
      busy = false;
    }
  }, 500); // 约 2 帧/秒，画面跟手动起来不卡顿

  syncRoomState();
  renderScrStrip();
  updateScrBtn();
  toast('🖥 屏幕已共享', `房间成员能看到「${scrTitle}」的缩略画面，再点一次停止`);
}

function scrStop(silent) {
  const was = scrOn;
  scrOn = false;
  scrTitle = '';
  if (scrTimer) {
    clearInterval(scrTimer);
    scrTimer = null;
  }
  if (scrStream) {
    scrStream.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    scrStream = null;
  }
  scrFrames.delete('self');
  if (was) {
    syncRoomState();
    renderScrStrip();
    updateScrBtn();
    if (!silent) toast('已停止共享屏幕', '房间内不再看到你的画面');
  }
}

function updateScrBtn() {
  const b = $('#scr-toggle');
  if (!b) return;
  b.textContent = scrOn ? '⏹ 停止共享屏幕' : '🖥 共享屏幕给房间';
  b.classList.toggle('warm', scrOn);
  b.classList.toggle('ghost', !scrOn);
}

function renderScrStrip() {
  const strip = $('#scr-strip');
  if (!strip) return;
  let html = '';
  if (scrOn) {
    html += `<div class="scr-tile" data-scr="self"><img alt="我"/><span class="scr-name">我 · ${esc(scrTitle)}</span></div>`;
  }
  for (const m of roomMembers) {
    if (m.self) continue;
    html += `<div class="scr-tile" data-scr="${esc(m.id || m.name)}" style="display:none"><img alt=""/><span class="scr-name">${esc(m.name || '同学')}</span></div>`;
  }
  strip.innerHTML = html
    ? `<div class="scr-head">🖥 屏幕共享中 <span class="scr-tip">（自愿分享 · 约 1 帧/秒）</span></div><div class="scr-row">${html}</div>`
    : '';
}

function updateScrFrames() {
  const strip = $('#scr-strip');
  if (!strip) return;
  const now = Date.now();
  for (const tile of strip.querySelectorAll('.scr-tile[data-scr]')) {
    const key = tile.dataset.scr;
    const f = scrFrames.get(key);
    const img = tile.querySelector('img');
    // 点缩略图 → 全屏查看
    tile.style.cursor = 'zoom-in';
    tile.onclick = () => openFrameViewer('scr', key, '共享屏幕' + (key === 'self' ? '（我）' : ''));
    if (f && now - f.at < 6000) {
      tile.style.display = '';
      if (img && img.dataset.cur !== String(f.at)) {
        img.src = f.url;
        img.dataset.cur = String(f.at);
      }
    } else if (key !== 'self') {
      tile.style.display = 'none';
    }
  }
}
setInterval(() => {
  if (roomJoined && $('#scr-strip')) updateScrFrames();
}, 1200);

/* ---- 自习房视图 ---- */

const AVATARS = ['🙂', '😀', '😎', '🤓', '🦊', '🐱', '🐼', '🐨', '🐯', '🦁', '🐸', '🦉'];

function renderStudy() {
  const p = state.profile;
  const room = state.room || {};
  roomJoined = !!room.inRoom; // 以主进程房间状态为准
  // 自己被禁言时同步横幅
  if (roomJoined && room.muted && room.muted.until > Date.now()) {
    muteSelf = { until: room.muted.until, reason: room.muted.reason };
  } else if (!roomJoined) {
    muteSelf = null;
  }
  console.log('[pq] renderStudy inRoom=' + roomJoined + ' members=' + roomMembers.length);
  $('#view').innerHTML = `
    <div class="view-head">
      <div class="view-title">自习房</div>
      <div class="view-sub">番茄钟 · 摄像头测心跳 · 局域网多人自习</div>
    </div>

    <div class="study-grid">
      <div class="panel pomo-panel">
        <h3>番茄钟</h3>
        <div class="pomo-wrap">
          <svg width="196" height="196" class="pomo-svg">
            <defs><linearGradient id="pomoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#7c6cff"/><stop offset="100%" stop-color="#17cda8"/>
            </linearGradient></defs>
            <circle cx="98" cy="98" r="84" fill="none" stroke="var(--panel-hover)" stroke-width="10"/>
            <circle id="pomo-ring" cx="98" cy="98" r="84" fill="none" stroke="url(#pomoGrad)" stroke-width="10"
              stroke-linecap="round" stroke-dasharray="${2 * Math.PI * 84}" stroke-dashoffset="0" transform="rotate(-90 98 98)"/>
          </svg>
          <div class="pomo-center">
            <span class="stage-tag idle" id="pomo-stage">待开始</span>
            <div class="pomo-time" id="pomo-time">25:00</div>
            <div class="pomo-today">🍅 今天 ${state.todayPomodoro} 个 · 专注 ${state.todayFocus} 分钟</div>
          </div>
        </div>
        <div class="pomo-presets">
          ${[[25, 5], [45, 10], [60, 15]].map(([f, b]) => `
            <button class="preset ${pomo.focusMin === f ? 'sel' : ''}" data-f="${f}" data-b="${b}" ${pomo.phase !== 'idle' ? 'disabled' : ''}>${f}+${b} 分钟</button>`).join('')}
        </div>
        <div class="pomo-btns">
          <button class="btn" id="pomo-start">▶ 开始专注</button>
          <button class="btn ghost" id="pomo-pause" style="display:none">暂停</button>
          <button class="btn ghost" id="pomo-abort" style="display:none">结束</button>
        </div>
        <div class="pomo-rule">规则：完成 1 个番茄 = 时长 × 0.8 积分（25 分钟 ≈ 20 分），休息不扣分。</div>
      </div>

      <div class="panel hr-panel">
        <h3>专注心跳</h3>
        <div class="hr-stage">
          <div class="hr-video-wrap">
            <video id="hr-video" autoplay playsinline muted></video>
            <div class="hr-overlay" id="hr-overlay">📷<span>开启摄像头后自动测心率</span></div>
          </div>
          <div class="hr-read">
            <div class="hr-bpm-row"><span class="hr-bpm" id="hr-bpm">--</span><span class="hr-unit">BPM</span></div>
            <div class="hr-status warming" id="hr-status">未开启</div>
            <div class="bar" style="margin-top:10px"><div class="bar-fill" id="hr-quality" style="width:0%;background:linear-gradient(90deg,#ffb454,#17cda8)"></div></div>
            <div class="hr-q-label">信号质量</div>
          </div>
        </div>
        <canvas id="hr-wave" class="hr-wave"></canvas>
        <button class="btn ghost" id="hr-toggle" style="width:100%;margin-top:12px">开启摄像头测心跳</button>
        <div class="pomo-rule">原理：摄像头捕捉面部血液微循环带来的肤色微变（rPPG），本地计算心率，画面不会上传。</div>
      </div>
    </div>

    <div class="panel room-panel">
      <div class="section-head" style="margin-bottom:12px">
        <h3 style="margin:0">多人自习房（局域网）</h3>
        ${roomJoined ? '<button class="btn small ghost" id="room-leave">退出房间</button>' : ''}
      </div>

      <div class="id-row">
        <div class="id-avatar" id="id-avatar">${esc(p.avatar || '🙂')}</div>
        <input class="input" id="id-name" maxlength="12" value="${esc(p.name || '我')}" style="width:150px"/>
        <button class="btn small ghost" id="id-save">保存身份</button>
        <div class="avatar-row" id="avatar-row">
          ${AVATARS.map((a) => `<button class="emoji-opt ${a === (p.avatar || '🙂') ? 'sel' : ''}" data-v="${a}">${a}</button>`).join('')}
        </div>
      </div>

      ${
        roomJoined
          ? `
        <div class="room-live">
          <span class="room-live-tag ${room.type === 'fun' ? 'fun' : ''}">${room.type === 'fun' ? '🎉 娱乐房' : '● 直播中'}</span>
          <span>房间码 <b>${esc(room.code || '')}</b>${room.isHost ? ` · 房主IP ${esc(room.ip || '')}` : ''} · 同一 WiFi 输入即可加入</span>
          ${room.type === 'fun' ? `<span class="fun-left" id="fun-left">⏳ --:--</span>` : ''}
        </div>
        ${muteSelf ? `<div class="mute-banner" id="mute-banner">🔇 你已被禁言：${esc(muteSelf.reason || '违反房间规则')} · 剩余 <b id="mute-left">--</b></div>` : ''}
        <div class="member-grid" id="member-grid"></div>
        <div class="cam-strip" id="cam-strip"></div>
        <div class="scr-strip" id="scr-strip"></div>
        <div class="cam-row">
          <button class="btn small ${lanVoice.on ? 'warm' : 'ghost'}" id="mic-toggle" title="点对点语音，不经过任何服务器">${lanVoice.on ? '🔇 关闭语音' : '🎤 开语音'}</button>
          <button class="btn small ${camOn ? 'warm' : 'ghost'}" id="cam-toggle">${camOn ? '⏹ 关闭摄像头共享' : '📷 开摄像头给房间看'}</button>
          <button class="btn small warm" id="ai-toggle" title="强制开启：关闭摄像头才会停止">🤖 AI 盯学 · 常开</button>
          <span class="ai-status" id="ai-status">${AIWatch.isRunning() ? '🤖 盯学中 · 已抓包 ' + (AIWatch.s() ? AIWatch.s().triggers : 0) + ' 次' : ''}</span>
          <button class="btn small ${scrOn ? 'warm' : 'ghost'}" id="scr-toggle">${scrOn ? '⏹ 停止共享屏幕' : '🖥 共享屏幕给房间'}</button>
          <span class="chat-tip">强制开启 · 开摄像头即盯学，退出房间自动结束</span>
        </div>
        <div class="ai-fb" id="ai-fb" hidden>
          <span class="ai-fb-t">🤖 刚才那帧真的是摸鱼吗？</span>
          <button class="btn small ghost" id="ai-fb-yes">确实是摸鱼</button>
          <button class="btn small ghost" id="ai-fb-no">我在学习（误判）</button>
          <span class="chat-tip">你的回答会存成训练样本</span>
        </div>
        <div class="reaction-row">
          ${['👍', '💪', '🔥', '🎉', '☕'].map((e) => `<button class="react-btn" data-e="${e}">${e}</button>`).join('')}
          <span class="react-tip">点一下给全房间加油</span>
          <button class="btn small ghost" id="room-invite" style="margin-left:auto">📨 拉人</button>
        </div>

        <div class="room-legion" id="room-legion" hidden></div>

        <div class="chat-panel">
          <div class="chat-head">
            <span>💬 房间聊天<span class="lgc-mention" id="chat-unread" hidden>0</span></span>
            <span class="chat-tip">发广告 / 刷屏 / 重复内容会被自动禁言</span>
          </div>
          <div class="ai-chat-bar" id="ai-chat-bar">
            <span class="ai-force">🟢 闲聊雷达 · 强制开启</span>
            <span class="ai-chat-stat" id="aichat-stat">${aiChatStatText()}</span>
            <span class="ai-chat-pen">闲聊攒到 ${AI_CHAT_LIMIT} 条自动扣 ${AI_CHAT_PENALTY} 分 · 强制扣，不可关闭</span>
          </div>
          <div class="chat-list" id="chat-list"></div>
          <div class="chat-input-row">
            <button class="btn ghost small" id="chat-attach" title="转发计划 / 房间链接 / 军团链接">📎</button>
            <div class="lgc-at-wrap">
              <input class="input" id="chat-input" maxlength="200" placeholder="${muteSelf ? '禁言中，暂时不能发言' : '说点什么，@ 可以点名（回车发送）'}" ${muteSelf ? 'disabled' : ''}/>
              <div class="lgc-at-box" id="chat-at-box" hidden></div>
            </div>
            <button class="btn small" id="chat-send" ${muteSelf ? 'disabled' : ''}>发送</button>
          </div>
          <div class="lgc-attach-menu" id="chat-attach-menu" hidden>
            <div class="lgc-attach-t">转发到房间</div>
            <button class="lgc-attach-item" data-rattach="plan-all">📋 我的全部计划（.pqplan）</button>
            <button class="lgc-attach-item" data-rattach="plan-normal">📋 只要普通计划</button>
            <button class="lgc-attach-item" data-rattach="plan-contract">📋 只要契约计划</button>
            <button class="lgc-attach-item" data-rattach="room">🏠 我的房间链接</button>
            <button class="lgc-attach-item" data-rattach="legion">🛡 我的军团链接</button>
            <div class="lgc-attach-note">计划里有备注，转发前会再问一次。房间里的链接贴到微信也能被人打开。</div>
          </div>
        </div>`
          : `
        <div class="room-entry">
          <div class="room-box">
            <div class="room-box-t">🏠 创建自习房</div>
            <p class="room-box-d">你当房主，同一 WiFi 下的朋友凭房间码加入。</p>
            <button class="btn" id="room-create">创建房间</button>
            <div id="room-created"></div>
          </div>
          <div class="room-box fun-box">
            <div class="room-box-t">🎉 开娱乐房</div>
            <p class="room-box-d">用积分兑换时长，房间内灰名单应用放行（黑名单仍强制关闭），最长 2 小时。</p>
            <div class="fun-dur-row">
              <input type="range" id="fun-min" min="10" max="120" step="10" value="30" class="range"/>
              <span class="fun-min-label"><b id="fun-min-val">30</b> 分钟</span>
            </div>
            <div class="fun-cost-row">消耗 <b id="fun-cost">45</b> 积分 · 余额 <b id="fun-bal">${p.points || 0}</b></div>
            <button class="btn warm" id="fun-create" style="width:100%">兑换并开房</button>
            <button class="btn ghost" id="net-open-fun" style="width:100%;margin-top:8px">🌐 异地开娱乐房（不经服务器）</button>
          </div>
          <div class="room-box">
            <div class="room-box-t">🚪 加入房间</div>
            <p class="room-box-d">输入房主的 IP 和房间码；也可直接用「拉人」邀请加入。</p>
            <div style="display:flex;gap:8px;margin-bottom:8px">
              <input class="input" id="join-ip" placeholder="房主 IP，如 192.168.1.6" style="flex:1"/>
              <input class="input" id="join-code" placeholder="房间码" maxlength="4" style="width:90px"/>
            </div>
            <button class="btn" id="room-join" style="width:100%">加入</button>
          </div>
          <div class="room-box net-box">
            <div class="room-box-t">🌐 异地联机（不经服务器）</div>
            <p class="room-box-d">不在同一个 WiFi 也能一起学：用微信互发一段连接码配对，之后聊天和画面走点对点直传，<b>不经过任何服务器</b>。</p>
            <button class="btn ghost" id="net-open" style="width:100%">打开异地联机</button>
          </div>
          <div class="room-box">
            <div class="room-box-t">🪟 房间独立窗口</div>
            <p class="room-box-d">把局域网房间开成一个<b>单独的窗口</b>（和主界面分开），方便全屏或双屏使用。</p>
            <div style="display:flex;gap:8px">
              <button class="btn ghost" id="room-win-study" style="flex:1">📚 自习房窗口</button>
              <button class="btn ghost" id="room-win-fun" style="flex:1">🎉 娱乐房窗口</button>
            </div>
          </div>
        </div>`
      }
    </div>
  `;

  bindStudyView(room);
  updatePomoUI();
  renderMembers();
  renderCamStrip();
  renderScrStrip();
}

function bindStudyView(room) {
  // 番茄钟
  $('#pomo-start') && ($('#pomo-start').onclick = () => pomoStart());
  $('#pomo-pause') && ($('#pomo-pause').onclick = () => (pomo.timer ? pomoPause() : pomoResume()));
  $('#pomo-abort') && ($('#pomo-abort').onclick = async () => {
    const ok = await confirmDialog('结束本节专注？', '未完成的番茄不计积分。');
    if (ok) pomoAbort();
  });
  $$('.preset').forEach((b) => {
    b.onclick = () => {
      pomo.focusMin = Number(b.dataset.f);
      pomo.breakMin = Number(b.dataset.b);
      pomo.left = 0;
      renderStudy();
    };
  });

  // 心跳
  $('#hr-toggle') && ($('#hr-toggle').onclick = hrToggle);
  setTimeout(() => drawWave([]), 60);

  // 房间摄像头共享
  $('#cam-toggle') && ($('#cam-toggle').onclick = camToggle);
  // 房间语音（点对点，自习房 / 娱乐房都能用）
  $('#mic-toggle') && ($('#mic-toggle').onclick = lanVoiceToggle);
  // 房间 AI 盯学（摸鱼检测）
  $('#ai-toggle') &&
    ($('#ai-toggle').onclick = () => {
      if (!AIWatch.isRunning()) return AIWatch.start(() => camStream);
      toast('🤖 AI 盯学是强制开启的', '想停下来就点「⏹ 关闭摄像头共享」，退出房间也会自动结束', false);
    });
  // AI 闲聊雷达：强制常开，只保留「自己聊太多扣分」这一项
  if (window.AIChat) AIChat.preload();
  chatLog.forEach((m) => !m.ai && classifyChat(m));
  aiChatPenalty = true; // 强制扣分：闲聊攒够条数一定扣，没有开关
  // AI 徽章：双击（或手机长按/右键）才能改判 → 走翻案风控
  if ($('#chat-list')) {
    $('#chat-list').onclick = (e) => {
      /* 点一下消息区就算「看过了」——只清本地的 @ 未读角标，不回任何已读回执 */
      if (chatUnreadAt) {
        chatUnreadAt = 0;
        paintChatUnread();
      }
      const pd = e.target.closest('[data-planid]');
      if (pd) {
        importRoomPlan(pd);
        return;
      }
      const th = e.target.closest('[data-thanks]');
      if (th) { sendThanks(th.dataset.thanks); th.disabled = true; return; }
      const rp = e.target.closest('[data-report]');
      if (rp) {
        const name = rp.dataset.report;
        chooseDialog(`举报 ${name}`, '选择一条理由。房内 ≥3 位不同同学同时举报，才会经核实记账；恶意举报会被降权。', [
          { label: '广告 / 乱发链接' },
          { label: '言语骚扰' },
          { label: '挂机 / 假装专注' },
          { label: '取消', ghost: true },
        ]).then((pick) => {
          const reasons = ['广告 / 乱发链接', '言语骚扰', '挂机 / 假装专注'];
          if (pick < 0 || pick >= reasons.length) return;
          sendReport(name, reasons[pick]);
        });
        return;
      }
      const v = e.target.closest('[data-vote]');
      if (v) {
        const [fid, vote] = v.dataset.vote.split(':');
        if (typeof api.roomChat === 'function') {
          api.roomChat(`🛡 复核意见 #${fid}:${vote}`).catch(() => {});
          v.disabled = true;
          toast('已投票', vote === 'agree' ? '认可这条翻案（≥1 票即转正）' : '不认可（2 票以上否决会直接作废）');
        }
        return;
      }
      const rm = e.target.closest('[data-room]');
      if (rm) {
        enterRoomFromLink(rm);
        return;
      }
      const lg = e.target.closest('[data-legion]');
      if (lg) {
        joinLegionFromLink(lg.getAttribute('data-legion'), window.PQLegion ? PQLegion.info() : null);
        return;
      }
      const pk = e.target.closest('[data-pk]');
      if (pk) { acceptPkFromLink(pk.getAttribute('data-pk')); return; }
      onChatBadgeClick(e);
    };
    $('#chat-list').oncontextmenu = (e) => {
      const b = e.target.closest('.chat-badge[data-fix]');
      if (!b) return;
      e.preventDefault();
      flipGesture = { id: '', at: 0 };
      openFlipDialog(b.dataset.fix);
    };
  }
  bindAiFeedback();
  // 房间屏幕共享
  $('#scr-toggle') && ($('#scr-toggle').onclick = scrToggle);
  // 异地联机：打开独立窗口（不叠在软件界面上）
  $('#net-open') && ($('#net-open').onclick = () => api.netOpenWindow('study'));
  $('#net-open-fun') && ($('#net-open-fun').onclick = () => api.netOpenWindow('fun'));
  // 局域网房间独立窗口
  $('#room-win-study') && ($('#room-win-study').onclick = () => api.roomOpenWindow('study'));
  $('#room-win-fun') && ($('#room-win-fun').onclick = () => api.roomOpenWindow('fun'));

  // 身份
  $('#id-save') && ($('#id-save').onclick = async () => {
    await api.profileUpdate({ name: $('#id-name').value.trim() || '我', avatar: $('#avatar-row .sel')?.dataset.v || '🙂' });
    toast('身份已保存', '在自习房中以此昵称出现');
  });
  $$('#avatar-row .emoji-opt').forEach((b) => {
    b.onclick = () => {
      $$('#avatar-row .sel').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      $('#id-avatar').textContent = b.dataset.v;
    };
  });

  // 房间
  $('#room-create') && ($('#room-create').onclick = async () => {
    const self = $('#room-create');
    if (!self) return;
    self.disabled = true;
    const res = await api.roomCreate({ type: 'study' });
    const self2 = $('#room-create');
    if (self2) self2.disabled = false;
    if (res.ok) {
      roomJoined = true;
      // 立刻拉一次最新状态，房主马上进入房间界面（不等广播）
      state = await api.getState();
      renderStudy();
      toast('房间已创建', `房间码 ${res.code} · 把 IP ${res.ip} 和房间码告诉朋友`);
    } else {
      toast(res.message || '创建失败', '', true);
    }
  });

  // 娱乐房：时长滑块 + 积分兑换
  if ($('#fun-min')) {
    const sync = () => {
      const m = Number($('#fun-min').value);
      $('#fun-min-val').textContent = m;
      $('#fun-cost').textContent = Math.ceil(m / 10) * 15;
      const cost = Math.ceil(m / 10) * 15;
      const enough = (state.profile.points || 0) >= cost;
      $('#fun-create').disabled = !enough;
      $('#fun-create').textContent = enough ? '兑换并开房' : `积分不足（差 ${cost - (state.profile.points || 0)} 分）`;
    };
    $('#fun-min').oninput = sync;
    sync();
    $('#fun-create').onclick = async () => {
      const minutes = Number($('#fun-min').value);
      const cost = Math.ceil(minutes / 10) * 15;
      if ((state.profile.points || 0) < cost) return toast('积分不足', `需要 ${cost} 分`, true);
      const ok = await confirmDialog(`花 ${cost} 积分开 ${minutes} 分钟娱乐房？`, '房间内灰名单应用放行，黑名单仍会被强制关闭；时间到自动结束。');
      if (!ok) return;
      const funBtn = $('#fun-create');
      if (funBtn) funBtn.disabled = true;
      const res = await api.roomCreate({ type: 'fun', minutes });
      const funBtn2 = $('#fun-create');
      if (funBtn2) funBtn2.disabled = false;
      if (res.ok) {
        roomJoined = true;
        // 立刻拉一次最新状态，房主马上进入房间界面（不等广播）
        state = await api.getState();
        renderStudy();
        toast('🎉 娱乐房已开', `${minutes} 分钟 · 消耗 ${cost} 积分 · 房间码 ${res.code}`);
      } else {
        toast(res.message || '创建失败', '', true);
      }
    };
  }

  $('#room-join') && ($('#room-join').onclick = async () => {
    const ip = $('#join-ip').value.trim();
    const code = $('#join-code').value.trim();
    if (!ip || !code) return toast('请填写 IP 和房间码', '', true);
    const joinBtn = $('#room-join');
    if (joinBtn) joinBtn.disabled = true;
    const err = await joinRoomChecked({ ip, port: 48765, code });
    const joinBtn2 = $('#room-join');
    if (joinBtn2) joinBtn2.disabled = false;
    if (err) toast(err, '', true);
  });

  /* 加入房间（带娱乐房入场扣分确认）。返回 null = 成功，否则返回错误文案 */
  async function joinRoomChecked({ ip, port, code }) {
    const info = await api.roomProbe({ ip, port, code });
    if (!info.ok) return info.message || '连不上对方';
    if (info.roomType === 'fun') {
      if (!info.leftMin) return '该娱乐房时间已到';
      if (!info.enough) return `积分不足：入场需 ${info.fee} 分，当前 ${info.points} 分`;
      const ok = await confirmDialog(
        `加入娱乐房需 ${info.fee} 积分`,
        `房间还剩 ${info.leftMin} 分钟，将从余额扣除；加入后灰名单应用放行（黑名单仍强制关闭）。`
      );
      if (!ok) return null;
    }
    const res = await api.roomJoin({ ip, port, code });
    if (!res.ok) return res.message || '加入失败';
    roomJoined = true;
    chatLog = Array.isArray(res.chat) ? res.chat : [];
    muteSelf = null;
    resetAiChat();
    // 立刻拉一次最新状态，成员/房主都马上进入房间界面
    state = await api.getState();
    renderStudy();
    if (res.type === 'fun') {
      toast(`已加入娱乐房 🎉${res.fee ? `（消耗 ${res.fee} 积分）` : ''}`, '房间内灰名单放行');
    } else {
      toast('已加入自习房 🎉');
    }
    return null;
  }
  $('#room-leave') && ($('#room-leave').onclick = async () => {
    await api.roomLeave();
    roomJoined = false;
    roomMembers = [];
    chatLog = [];
    muteSelf = null;
    resetAiChat();
    lanVoiceStop(true);
    camStop(true);
    camFrames.clear();
    scrStop(true);
    scrFrames.clear();
    if (funTickTimer) clearInterval(funTickTimer);
    renderStudy();
  });
  $$('.react-btn').forEach((b) => (b.onclick = () => api.roomReaction(b.dataset.e)));

  // 聊天
  renderChat();
  paintChatUnread();
  paintRoomLegion();
  if ($('#chat-send')) {
    const myRecent = [];
    const send = async (attach) => {
      const input = $('#chat-input');
      const text = input.value.trim();
      const hasLink = !!(attach && attach.kind);
      if (!text && !hasLink) return;

      /* 频道秩序：先看「有没有资格说」，再看「说的是什么」。
         禁言是房间级的，不直接写信誉分账本；被禁言三次 → 单人小黑屋（只有自己看得见）。 */
      const mod = window.ChatMod;
      const mid = (state && state.room && state.room.myId) || 'me';
      if (mod) {
        const credit = state && state.credit ? Number(state.credit.score) : 100;
        const gate = mod.canSpeak(credit, false);
        if (!gate.ok) {
          toast('还不能发言', gate.reason, true);
          alaScold('warn', gate.reason);
          return { ok: false, message: gate.reason };
        }
        const left = mod.muteLeft(mid);
        if (left > 0) {
          toast('你还在禁言中', `还剩 ${Math.ceil(left / 60e3)} 分钟`, true);
          alaScold('mute', `还剩 ${Math.ceil(left / 60e3)} 分钟`);
          return { ok: false, message: '禁言中' };
        }
        if (text) {
          const r = mod.scan(text, myRecent);
          if (r.level === 'mute') {
            mod.mute(mid, r.minutes, r.reason);
            toast(`已禁言 ${r.minutes} 分钟`, r.reason + ' · 三次以上会进单人小黑屋（只有你自己看得见）', true);
            alaScold('mute', `${r.reason} · 禁言 ${r.minutes} 分钟`);
            api.roomChat(`🔇 有人因${r.reason}被禁言 ${r.minutes} 分钟`).catch(() => {});
            return { ok: false, message: r.reason };
          }
          if (r.level === 'warn') { toast('注意措辞', r.reason + ' · 再犯会被禁言', true); alaScold('warn', r.reason); }
          myRecent.push({ at: Date.now(), text });
          if (myRecent.length > 20) myRecent.splice(0, myRecent.length - 20);
        }
      }

      input.value = '';
      hideRoomAtBox();
      const res = await api.roomChat(text, hasLink ? attach : undefined);
      if (!res || !res.ok) toast((res && res.message) || '发送失败', '', true);
      return res || { ok: false };
    };
    $('#chat-send').onclick = () => send();
    const cin = $('#chat-input');
    cin.onkeydown = (e) => {
      if (e.key === 'Escape') {
        hideRoomAtBox();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    };
    /* @ 补全：输入 @ 就列出房间里的人 */
    cin.oninput = () => paintRoomAtBox();
    cin.onblur = () => setTimeout(hideRoomAtBox, 150);

    /* 📎 转发：计划 / 房间 / 军团 */
    const ab = $('#chat-attach');
    const am = $('#chat-attach-menu');
    if (ab && am) {
      ab.onclick = () => {
        am.hidden = !am.hidden;
      };
      am.querySelectorAll('[data-rattach]').forEach((b) => {
        b.onclick = async () => {
          const what = b.getAttribute('data-rattach');
          am.hidden = true;
          await forwardToRoom(what, send);
        };
      });
      document.addEventListener('click', (e) => {
        if (!am.hidden && !am.contains(e.target) && e.target !== ab) am.hidden = true;
      });
    }
  }

  // 拉人
  $('#room-invite') && ($('#room-invite').onclick = openInviteDialog);
  startOnlineCredit();

  // 禁言倒计时 / 娱乐房倒计时
  startFunTick();
}

/* ---- 收到邀请 ---- */

function showInvite(evt) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const isFun = evt.roomType === 'fun';
  mask.innerHTML = `
    <div class="modal" style="width:380px">
      <h2>${isFun ? '🎉 娱乐房邀请' : '📚 自习房邀请'}</h2>
      <p class="modal-sub"><b>${esc(evt.from)}</b> 邀请你加入${isFun ? '娱乐房' : '自习房'}（房间码 ${esc(evt.code)}）</p>
      <div class="form-foot">
        <button class="btn ghost" data-r="0">忽略</button>
        <button class="btn" data-r="1">加入</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', async (e) => {
    const r = e.target.dataset.r;
    if (e.target === mask || r === '0') return mask.remove();
    if (r === '1') {
      mask.remove();
      // 先探测：娱乐房加入要确认入场积分
      const info = await api.roomProbe({ ip: evt.ip, port: evt.port, code: evt.code });
      if (!info.ok) return toast(info.message || '连不上对方', '', true);
      if (info.roomType === 'fun') {
        if (!info.leftMin) return toast('该娱乐房时间已到', '', true);
        if (!info.enough) return toast(`积分不足：入场需 ${info.fee} 分，当前 ${info.points} 分`, '', true);
        const ok = await confirmDialog(
          `加入娱乐房需 ${info.fee} 积分`,
          `${evt.from} 的娱乐房还剩 ${info.leftMin} 分钟，将从余额扣除。`
        );
        if (!ok) return;
      }
      const res = await api.roomJoin({ ip: evt.ip, port: evt.port, code: evt.code });
      if (res.ok) {
        roomJoined = true;
        chatLog = Array.isArray(res.chat) ? res.chat : [];
        muteSelf = null;
        resetAiChat();
        toast(res.type === 'fun' ? `已加入娱乐房 🎉${res.fee ? `（消耗 ${res.fee} 积分）` : ''}` : '已加入自习房 🎉');
        switchView('study');
      } else {
        toast(res.message || '加入失败', '', true);
      }
    }
  });
}

/* ---- AI 闲聊雷达：判定房间聊天是「工作/学习」还是「摸鱼闲聊」 ---- */

const AI_CHAT_PENALTY = 2;   // 抓包一次扣分
const AI_CHAT_WINDOW = 5 * 60 * 1000; // 自己闲聊统计窗口
const AI_CHAT_LIMIT = 3;     // 窗口内闲聊达到几条 → 扣分
/* 只有「比较确定是闲聊」才扣分：语音转写本来就含糊，
   0.5 上下摇摆的判定会把「读书声 / 说了句正经话」也算成摸鱼，扣分扣得莫名其妙 */
const AI_FISH_CONF = 0.7;

function aiChatStatText() {
  if (!aiChatOn) return '已关闭';
  if (!aiChatStat) return '待机中…';
  const s = aiChatStat;
  if (!s.total) return '等第一条消息';
  const pct = Math.round((s.fish / s.total) * 100);
  return `已判 ${s.total} 条 · 闲聊 ${s.fish} 条（${pct}%）`;
}

function refreshAiChatBar() {
  const stat = $('#aichat-stat');
  if (stat) stat.textContent = aiChatStatText();
}

/* 判定一条聊天并回写 msg.ai，然后刷新该条气泡（避免整列表重渲染） */
function classifyChat(msg) {
  if (!aiChatOn || !msg || msg.sys) return;
  if (!window.AIChat || typeof AIChat.classify !== 'function') return;
  if (/^🤖/.test(String(msg.text || ''))) return; // AI 自己的广播不判
  if (/^🛡 (翻案待复核|复核意见)/.test(String(msg.text || ''))) return; // 风控复核消息不参与闲聊判定
  if (/^(🙏 感谢 @|🚩 举报 @|✅ 举报属实)/.test(String(msg.text || ''))) return; // 互助/举报消息不判闲聊
  aiChatStat = aiChatStat || { total: 0, fish: 0, work: 0, skip: 0 };
  const mine = msg.memberId && msg.memberId === (state?.room?.myId || '');
  AIChat.classify(msg.text)
    .then((r) => {
      if (!r || !r.label || r.label === 'error') return;
      msg.ai = { label: r.label, p: r.p };
      aiChatStat.total += 1;
      if (r.label === 'fish') aiChatStat.fish += 1;
      else if (r.label === 'work') aiChatStat.work += 1;
      else aiChatStat.skip += 1;
      refreshAiChatBar();
      patchChatBadge(msg);
      if (mine && r.label === 'fish' && r.p >= AI_FISH_CONF && aiChatPenalty) noteMyFish();
      if (mine && r.label === 'fish' && r.p >= AI_FISH_CONF) applyFlipEvidence();
    })
    .catch(() => {});
}

/* 只更新单条气泡上的徽章，避免整段列表闪动 */
function patchChatBadge(msg) {
  const list = $('#chat-list');
  if (!list || !msg.id) return;
  const el = list.querySelector(`[data-cid="${msg.id}"] .chat-badge-slot`);
  if (el) el.innerHTML = chatBadgeHtml(msg);
}

function chatBadgeHtml(m) {
  if (!aiChatOn || !m || !m.ai) return '';
  const fix = ` data-fix="${esc(m.id || '')}" title="双击（或长按）改判"`;
  const pend = m.ai.pending != null ? `<span class="chat-badge pending" title="已进候选池，还没进训练集">⏳ 待确认</span>` : '';
  if (m.ai.label === 'fish') return `<span class="chat-badge fish"${fix}>🐟 闲聊 ${Math.round(m.ai.p * 100)}%</span>${pend}`;
  if (m.ai.label === 'work') return `<span class="chat-badge work"${fix}>📖 正经事 ${Math.round((1 - m.ai.p) * 100)}%</span>${pend}`;
  return '';
}

/* 隐式反馈：刚翻完案就又连续聊 → 翻案自动作废 + 扣信用分 */
function applyFlipEvidence() {
  if (!window.FlipGuard || !window.AITrain) return;
  const g = FlipGuard.onFishEvidence();
  if (!g || !g.rolled) return;
  (g.sampleIds || []).forEach((id) => AITrain.setSampleStatus(id, 'rollback'));
  /* 气泡上的「已改判」也要撑销，回到闲聊 */
  chatLog.forEach((m) => {
    if (m && m.ai && m.ai.fixed && m.ai.label !== 'fish') m.ai = { label: 'fish', p: 0.9 };
  });
  chatLog.forEach((m) => patchChatBadge(m));
  if (typeof api.creditPenalize === 'function') {
    api.creditPenalize({ amount: g.penalty, note: '翻案后行为不一致，自动回滚' }).then(() => {
      if (state && state.credit) state.credit.score = Math.max(0, (state.credit.score || 0) - g.penalty);
    }).catch(() => {});
  }
  creditEvt('flip_bad', '翻案后 10 分钟内行为不一致，自动回滚');
  toast(
    '↩ 翻案被行为打脸，已自动回滚',
    `10 分钟内又连续被判闲聊：作废 ${g.rolled} 条样本 · 信用 -${g.penalty}` + (g.locked ? ' · 今日翻案已锁定' : ''),
    true
  );
  if (currentView === 'settings') renderSettings();
}

/* 自己连续闲聊 → 扣分（每窗口只扣一次，允许扣成负分） */
function noteMyFish() {
  const now = Date.now();
  aiChatMine = aiChatMine.filter((t) => now - t < AI_CHAT_WINDOW);
  aiChatMine.push(now);
  if (aiChatMine.length < AI_CHAT_LIMIT) {
    const left = AI_CHAT_LIMIT - aiChatMine.length;
    if (left <= 2) {
      if (window.PQAlly) window.PQAlly.card('warn', { title: `再聊 ${left} 条我就得跟你一起扣分了`, body: `不是催你，是怕你晚上想起这事难受。`, mood: 'worried' });
      else toast('🤖 闲聊雷达', `再聊 ${left} 条无关内容就要扣 ${AI_CHAT_PENALTY} 积分`, false);
    }
    return;
  }
  aiChatMine = [];
  // 话术：系统不是狱警，是和你一起对付「那个想偷懒的自己」的战友
  if (window.PQAlly) {
    window.PQAlly.card('chat', { title: '咱俩逮到了', body: `不是「系统抓你」，是咱俩一起发现的——那家伙又冒头了。\n扣 ${AI_CHAT_PENALTY} 分，喝口水，回来接着学。`, mood: 'fired' });
  } else {
    toast(`🤝 我们一起逮到 ${AI_CHAT_LIMIT} 条闲聊`, `扣 ${AI_CHAT_PENALTY} 分 · 回来接着学`, true);
  }
  if (typeof api.aiPenalty === 'function') {
    api.aiPenalty(-AI_CHAT_PENALTY)
      .then((res) => {
        if (res && typeof res.points === 'number' && state?.profile) state.profile.points = res.points;
      })
      .catch(() => {});
  }
}

/* 语音转写结果 → 同一闲聊判定（与打字聊天同模型、同窗口、同扣分） */
let voiceLastTexts = [];
function judgeVoiceText(text) {
  if (!aiChatOn) return;
  if (!window.AIChat || typeof AIChat.classify !== 'function') return;
  const now = Date.now();
  voiceLastTexts = voiceLastTexts.filter((x) => now - x.at < 60 * 1000);
  if (voiceLastTexts.some((x) => x.text === text)) return; // 1 分钟内重复的话只算一次
  voiceLastTexts.push({ text, at: now });
  aiChatStat = aiChatStat || { total: 0, fish: 0, work: 0, skip: 0 };
  AIChat.classify(text)
    .then((r) => {
      if (!r || !r.label || r.label === 'error') return;
      aiChatStat.total += 1;
      if (r.label === 'fish' && r.p >= AI_FISH_CONF) {
        aiChatStat.fish += 1;
        refreshAiChatBar();
        noteMyFish();
        toast('🎙 语音闲聊', `「${text.slice(0, 24)}」闲聊 ${Math.round(r.p * 100)}%`, false);
      } else {
        aiChatStat.work += 1;
        refreshAiChatBar();
      }
    })
    .catch(() => {});
}

function resetAiChat() {
  aiChatStat = null;
  aiChatMine = [];
  refreshAiChatBar();
}

/* ---- AI 自训练：样本采集 / 纠错 / 模型面板 ---- */

/* 点聊天徽章 → 纠正判定（翻案）：双击/长按才触发，必须选理由，再由翻案风控决定是否采纳 */
let flipGesture = { id: '', at: 0 };
const FLIP_REASONS = ['AI 误判', '上下文误解', '漏看关键信息', '确实是玩笑/反讽'];

/* 翻案前注入上下文：信用分（与借贷同一套）、失信截止、近期闲聊占比 */
function syncFlipContext() {
  if (!window.FlipGuard) return;
  const cr = (state && state.credit) || {};
  const st = aiChatStat;
  const fishRatio = st && st.total >= 5 ? st.fish / st.total : 0;
  FlipGuard.setContext({
    score: Number(cr.score == null ? 100 : cr.score),
    blockUntil: Number(cr.blockUntil || 0),
    fishRatio,
  });
}

/* 信誉分记账：诚实度 / 联盟贡献 / 成长（与借贷共用 0~160 分，后端带每日上限） */
function creditEvt(type, note) {
  if (!window.api || typeof api.creditEvent !== 'function') return;
  api.creditEvent({ type, note }).then((r) => {
    if (!r || !r.ok || !r.delta) return;
    if (state && state.credit) state.credit.score = r.score;
    if (r.score === 0) toast('⛓ 信誉分清零 · 进入失信期', '24 小时内不能借分、不能翻案；好好打卡慢慢爬回来', true);
    else if (r.delta > 0) toast('信誉 +' + r.delta, String(note || ''));
  }).catch(() => {});
}

/* 联机正向行为：感谢帮助（对方确认才算，每人每天对同一人只记一次） */
const THANKS_KEY = 'pq-thanks-v1';
function thanksState() {
  try {
    const d = JSON.parse(localStorage.getItem(THANKS_KEY) || '{}');
    const today = new Date().toISOString().slice(0, 10);
    if (d.date !== today) return { date: today, to: {} };
    return { date: today, to: d.to || {} };
  } catch (_) {
    return { date: new Date().toISOString().slice(0, 10), to: {} };
  }
}
function sendThanks(name) {
  const me = (state?.profile?.name || '我');
  if (!name || name === me) return toast('不能感谢自己', '找别人吧', true);
  const st = thanksState();
  if (st.to[name] >= 1) return toast('今天已经感谢过 TA 了', '互刷好感没意义，明天再说', true);
  st.to[name] = 1;
  try { localStorage.setItem(THANKS_KEY, JSON.stringify(st)); } catch (_) {}
  api.roomChat(`🙏 感谢 @${name}`).catch(() => {});
  toast('已送出感谢', `对方确认收到后，TA 的联盟贡献会 +2（每天上限）`);
}

/* 举报：房内 ≥3 位不同同学举报同一人 → 由被举报者客户端记账；举报者收到「✅ 举报属实」回执才加分 */
const REPORT_KEY = 'pq-reports-v1';
function reportState() {
  try {
    const d = JSON.parse(localStorage.getItem(REPORT_KEY) || '{}');
    const today = new Date().toISOString().slice(0, 10);
    if (d.date !== today) return { date: today, mine: {}, targets: {}, hist: d.hist || [] };
    return { date: today, mine: d.mine || {}, targets: d.targets || {}, hist: d.hist || [] };
  } catch (_) {
    return { date: new Date().toISOString().slice(0, 10), mine: {}, targets: {}, hist: [] };
  }
}
function saveReportState(st) {
  try { localStorage.setItem(REPORT_KEY, JSON.stringify(st)); } catch (_) {}
}
async function sendReport(name, reason) {
  const me = (state?.profile?.name || '我');
  if (!name || name === me) return;
  const st = reportState();
  const key = name;
  st.mine[key] = st.mine[key] || { n: 0, ok: 0 };
  st.mine[key].n += 1;
  /* 7 天内 5 次举报 0 次核实 → 记一次恶意举报，之后举报权重归零（本机口径） */
  const hist = st.hist.filter((x) => Date.now() - x.at < 7 * 86400000);
  const totalN = hist.length + 1;
  const totalOk = hist.filter((x) => x.ok).length + st.mine[key].ok;
  st.hist = hist;
  saveReportState(st);
  if (totalN >= 5 && totalOk === 0) {
    creditEvt('report_bad', '多次举报均未核实，标记恶意举报，举报权重降为 0');
    toast('🚩 举报权重已降为 0', '7 天内 5 次举报 0 次核实，先别再举报了', true);
    return;
  }
  api.roomChat(`🚩 举报 @${name}：${reason}`).catch(() => {});
  toast('已提交举报', '需要房里 3 位不同同学同时举报并经核实，才会记账');
}

function onChatBadgeClick(e) {
  const badge = e.target.closest('.chat-badge[data-fix]');
  if (!badge) return;
  const id = badge.dataset.fix;
  const now = Date.now();
  /* 第一下只提示，第二下（800ms 内）才算真改——防手滑，也防别人拿你手机划两下 */
  if (flipGesture.id !== id || now - flipGesture.at > 800) {
    flipGesture = { id, at: now };
    toast('再点一次才能改判', '双击徽章（手机上长按）才进入纠正流程 · 手滑不算', false);
    return;
  }
  flipGesture = { id: '', at: 0 };
  openFlipDialog(id);
}

async function openFlipDialog(id) {
  const msg = chatLog.find((m) => m.id === id);
  if (!msg || !msg.ai) return;
  const isFish = msg.ai.label === 'fish';
  const pct = Math.round((isFish ? msg.ai.p : 1 - msg.ai.p) * 100);
  const truth = isFish ? 0 : 1;

  const reasonPick = await chooseDialog(
    '翻案理由（必选）',
    `「${String(msg.text || '').slice(0, 40)}」被判成${isFish ? '闲聊' : '正经事'}（${pct}%）。\n翻案不是投票，是给训练样本纠错——必须说明理由，并会记入审计。`,
    FLIP_REASONS.map((r) => ({ label: r })).concat([{ label: '不改了', ghost: true }])
  );
  if (reasonPick < 0 || reasonPick >= FLIP_REASONS.length) return;
  const reason = FLIP_REASONS[reasonPick];

  syncFlipContext();
  const fs = window.FlipGuard ? FlipGuard.status() : null;
  const pick2 = await chooseDialog(
    '确认改判？',
    `把这条从「${isFish ? '闲聊' : '正经事'}」改为「${truth ? '闲聊' : '正经事'}」（理由：${reason}）。\n\n` +
      (fs
        ? `你当前信用 ${fs.score}（${fs.tier}）· 今日翻案 ${fs.used}/${fs.quota} · 权重 ${fs.weight}。\n` +
          (fs.direct
            ? '信用良好以上：行为一致才直接采纳，否则仍进候选池。'
            : '信用未达「良好」：只能进候选池，冷静 30 分钟后二次确认或由相似翻案佐证才进训练集。') +
          (fs.rookie ? `\n🐣 新手期还剩 ${fs.rookieLeft} 天：这次改判只在本机生效，样本不进训练集、不上传。` : '')
        : '翻案风控未加载，本次不可提交。'),
    [{ label: '确认提交' }, { label: '算了', ghost: true }]
  );
  if (pick2 !== 0) return;

  if (!window.FlipGuard || !window.AITrain) return toast('翻案风控未加载', '请重启软件后再试', true);
  const g = FlipGuard.request({ kind: 'text', text: msg.text, from: isFish ? 1 : 0, to: truth, reason });
  if (!g.ok) return toast('翻案被拦下', g.message, true);

  const s = AITrain.addTextSample(msg.text, truth, '聊天纠错', { status: g.status, weight: g.weight });
  FlipGuard.attachSample(g.flip.id, s && s.id);

  if (g.direct) {
    /* 只有直接采纳才立刻改判；候选池里的一律维持原判，只挂「待确认」 */
    msg.ai = { label: truth === 1 ? 'fish' : 'work', p: truth === 1 ? 0.99 : 0.01, fixed: true };
    patchChatBadge(msg);
    toast(
      g.rookie ? '✅ 已改判（本机生效）' : '✅ 翻案已采纳',
      g.rookie ? g.message + ' · 新手期样本只作参考，不进训练集、不上传' : g.message + '（已同时写入训练集）'
    );
  } else {
    msg.ai = Object.assign({}, msg.ai, { pending: truth });
    patchChatBadge(msg);
    toast(
      '⏳ 已进候选池',
      g.message +
        (g.rookie ? ' · 新手期复核通过也只作参考，不进训练集' : ' · 还不能改判，先去「设置 → AI 自训练 → 翻案候选池」走复核')
    );
    /* 众包复核：在房间里就发一条「待复核」，其他同学可一票认可 / 不认可（取多数） */
    if (roomJoined && typeof api.roomChat === 'function') {
      const preview = String(msg.text || '').replace(/[\r\n]+/g, ' ').slice(0, 18);
      api.roomChat(`🛡 翻案待复核 #${g.flip.id}：「${preview}」→ ${truth ? '闲聊' : '正经事'}`).catch(() => {});
    }
  }
  if (currentView === 'settings') renderSettings();
}

/* AI 盯学抓包后问一句：这一帧算不算摸鱼 → 画面校准样本 */
let aiFbTimer = null;
function showAiFeedback() {
  const bar = $('#ai-fb');
  if (!bar) return;
  bar.hidden = false;
  if (aiFbTimer) clearTimeout(aiFbTimer);
  aiFbTimer = setTimeout(() => {
    bar.hidden = true;
  }, 30000);
}
function bindAiFeedback() {
  const yes = $('#ai-fb-yes');
  const no = $('#ai-fb-no');
  if (!yes || !no) return;
  const save = async (y) => {
    const shot = window.AIWatch && AIWatch.getShot ? AIWatch.getShot() : null;
    const bar = $('#ai-fb');
    if (bar) bar.hidden = true;
    if (aiFbTimer) clearTimeout(aiFbTimer);
    if (!window.AITrain || !shot) return;
    const truth = y ? 1 : 0;
    if (!window.FlipGuard) {
      /* 风控模块没加载就不往训练集里塞任何东西 */
      return toast('翻案风控未加载', '请重启软件后再试', true);
    }
    /* 画面翻案与文字翻案同一套：选理由 → 名额/冷却 → 直接采纳或进候选池 */
    const pick = await chooseDialog(
      y ? '确认这只是偶发走神？' : '为什么不算摸鱼？（必选）',
      `画面样本会参与你自己的「温度 + 阈值」校准，错标会直接把模型带歪。\n选一句最接近的理由，并会记入审计。`,
      FLIP_REASONS.map((r) => ({ label: r })).concat([{ label: '不改了', ghost: true }])
    );
    if (pick < 0 || pick >= FLIP_REASONS.length) return;
    syncFlipContext();
    const g = FlipGuard.request({
      kind: 'image',
      text: '📷 画面帧 · AI 判摸鱼',
      from: 1,
      to: truth,
      reason: FLIP_REASONS[pick],
    });
    if (!g.ok) return toast('画面翻案被拦下', g.message, true);
    const s = AITrain.addImageSample(shot, truth, { status: g.status, weight: g.weight });
    FlipGuard.attachSample(g.flip.id, s && s.id);
    const c = AITrain.counts();
    toast(
      g.rookie ? '✅ 画面已改判（本机生效）' : g.direct ? '✅ 画面样本已采纳' : '⏳ 画面样本进了候选池',
      g.rookie
        ? g.message + ' · 新手期画面样本只用来校准你自己看，不进训练集、不上传'
        : g.direct
          ? g.message
          : g.message + '（候选池里的样本不参与训练、不上传云端）'
    );
    if (currentView === 'settings') renderSettings();
  };
  yes.onclick = () => save(1);
  no.onclick = () => save(0);
}
/* ai-watch.js 抓到摸鱼时回调（三端共用同一钩子） */
window.onAIWatched = () => {
  if (currentView === 'study' && roomJoined) showAiFeedback();
};

/* 设置页：阿刺引擎面板
 * 四选：美团 LongCat（每日 10 万免费 token）/ 本机 Qwen3-4B / 自定义模型 / 纯查表
 * 查表永远优先；模型不可用时自动纯查表兜底 */
function alaEnginePanelHTML() {
  const B = window.PQBuddy;
  if (!B || !B.alaCfgApi) return '';
  const c = B.alaCfgApi.get();
  const mode = B.alaCfgApi.mode ? B.alaCfgApi.mode() : 'qwen';
  const LC = (window.AlaLLM && AlaLLM.LONGCAT) || { endpoint: 'https://api.longcat.chat/openai', model: 'LongCat-Flash-Chat', site: 'https://longcat.chat/platform' };
  const info = B.info().ala;
  const caps = (B.alaCfgApi.caps && B.alaCfgApi.caps()) || { plan: true, edit: true, msg: true };
  const ro = !!(B.alaCfgApi.ro && B.alaCfgApi.ro());
  const net = (B.alaCfgApi.net && B.alaCfgApi.net()) || { on: false, endpoint: '' };
  const tts = (B.alaCfgApi.tts && B.alaCfgApi.tts()) || { on: false, endpoint: '', speed: 1 };
  const st = mode === 'table'
    ? '⚡ 极速模式（手动选定）'
    : (info && info.ok
        ? `🧠 已接上：${esc(info.model)}`
        : `⚡ 极速模式（${netReason(info && info.detail)}，先查表兜底）`);
  return `
    <div class="panel">
      <h3>阿刺引擎 <span class="tag">本地优先 + 模型</span></h3>
      <div class="sd" style="margin:4px 0 12px">
        问进度/积分/连击这些，本机现算秒回、不编数。
        复杂些的才交给模型——<b>提示词里限死了：只说本机数据，不编，答不了就说不知道</b>。
        模型接不上时<b>自动用极速应答兜底</b>，软件照常能用。
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="st">模型来源</div>
          <div class="sd">四个选项：LongCat（美团长猫，官方站 longcat.ai / API 平台 longcat.chat，每日 10 万免费 token，不用装东西）/ 本机 Qwen3-4B / 自定义模型 / 纯查表。<br/>
            <b>本机 Qwen3-4B 要先装 Ollama</b>（ollama.com，装完 <code>ollama pull qwen2.5:3b</code>，它会自己占 11434 端口）；
            <b>没装就别选这项</b>——选 LongCat 或纯查表，功能一样能跑，只是回答短一点。</div>
        </div>
        <select class="select" id="ala-mode">
          <option value="meituan" ${mode === 'meituan' ? 'selected' : ''}>LongCat（美团长猫，每日 10 万免费 token）</option>
          <option value="qwen" ${mode === 'qwen' ? 'selected' : ''}>Qwen3-4B（本机 Ollama）</option>
          <option value="custom" ${mode === 'custom' ? 'selected' : ''}>自定义模型（Ollama / OpenAI 兼容）</option>
          <option value="table" ${mode === 'table' ? 'selected' : ''}>纯查表（只答本机数据，不接模型）</option>
        </select>
      </div>

      <div id="ala-meituan-box" ${mode === 'meituan' ? '' : 'hidden'}>
        <div class="set-row">
          <div class="set-info">
            <div class="st">LongCat API Key<span class="tag">美团长猫</span>${c.meituanKey ? ' <span class="tag">已填</span>' : ''}</div>
            <div class="sd">LongCat（美团长猫，LongCat-Flash 系列）是<b>美团技术团队</b>自研并开源的大模型，有自己的开放平台：官方站 <code>longcat.ai</code>，API 平台 <code>longcat.chat</code>。
              每个账号<b>每日 10 万免费 tokens</b>，北京时间凌晨自动刷新。注册后平台会自动建一个名为 default 的 Key，在「API Keys」页复制到这儿即可。
              <br/><b>提示：</b>在搜索引擎里搜「美团 LongCat」很容易被外卖业务淹没——别搜，直接点右边「去注册」（或手动输 <code>longcat.chat/platform</code>）。</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <input class="input" id="ala-meituan-key" type="password" autocomplete="off" style="max-width:210px" placeholder="粘贴 API Key" value="${esc(c.meituanKey || '')}" />
            <button class="btn small" id="ala-meituan-open">去注册</button>
          </div>
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="st">接口</div>
            <div class="sd">OpenAI 兼容端点 <code>${esc(c.meituanEndpoint || LC.endpoint)}</code> · 模型 <code>${esc(c.meituanModel || LC.model)}</code>。
              请求由本机主进程直连美团，不经过任何第三方中转。</div>
          </div>
        </div>
        <details class="set-adv">
          <summary>高级：换端点 / 模型（只有走中转时才需要改）</summary>
          <div class="set-row">
            <div class="set-info"><div class="st">接口地址</div><div class="sd">默认 ${esc(LC.endpoint)}</div></div>
            <input class="input" id="ala-meituan-endpoint" style="max-width:240px" placeholder="${esc(LC.endpoint)}" value="${esc(c.meituanEndpoint || '')}" />
          </div>
          <div class="set-row">
            <div class="set-info"><div class="st">模型名</div><div class="sd">默认 ${esc(LC.model)}（平台另有 Flash-Lite / Flash-Thinking 等型号）</div></div>
            <input class="input" id="ala-meituan-model" style="max-width:240px" placeholder="${esc(LC.model)}" value="${esc(c.meituanModel || '')}" />
          </div>
        </details>
      </div>

      <div id="ala-qwen-box" ${mode === 'qwen' ? '' : 'hidden'}>
        <div class="set-row">
          <div class="set-info">
            <div class="st">本机 Qwen3-4B</div>
            <div class="sd">完全离线：<a href="https://ollama.com" target="_blank" rel="noreferrer">ollama.com</a> 装 Ollama →
              命令行 <code>ollama pull qwen3:4b</code> → 回来点「重新探测」。默认地址 http://127.0.0.1:11434。</div>
          </div>
        </div>
        <details class="set-adv">
          <summary>高级：地址 / 模型名</summary>
          <div class="set-row">
            <div class="set-info"><div class="st">Ollama 地址</div><div class="sd">默认 http://127.0.0.1:11434</div></div>
            <input class="input" id="ala-qwen-endpoint" style="max-width:240px" placeholder="http://127.0.0.1:11434" value="${esc(c.endpoint || '')}" />
          </div>
          <div class="set-row">
            <div class="set-info"><div class="st">模型名</div><div class="sd">默认 qwen3:4b（ollama list 里看到的名字）</div></div>
            <input class="input" id="ala-qwen-model" style="max-width:240px" placeholder="qwen3:4b" value="${esc(c.model || '')}" />
          </div>
        </details>
      </div>

      <div id="ala-custom-box" ${mode === 'custom' ? '' : 'hidden'}>
        <div class="set-row">
          <div class="set-info"><div class="st">接口地址</div><div class="sd">如 http://127.0.0.1:11434（Ollama）或任意 OpenAI 兼容地址（带 /v1 也可以）。</div></div>
          <input class="input" id="ala-endpoint" style="max-width:240px" placeholder="http://127.0.0.1:11434" value="${esc(c.endpoint || '')}" />
        </div>
        <div class="set-row">
          <div class="set-info"><div class="st">模型名</div><div class="sd">Ollama 用 ollama list 里看到的名字。</div></div>
          <input class="input" id="ala-model" style="max-width:240px" placeholder="qwen3:4b" value="${esc(c.model || '')}" />
        </div>
        <div class="set-row">
          <div class="set-info"><div class="st">接口类型</div><div class="sd">ollama = /api/chat；openai = /v1/chat/completions（需要填 Key 的话在下面）。</div></div>
          <select class="select" id="ala-kind">
            <option value="ollama" ${(c.kind || 'ollama') === 'ollama' ? 'selected' : ''}>Ollama</option>
            <option value="openai" ${c.kind === 'openai' ? 'selected' : ''}>OpenAI 兼容</option>
          </select>
        </div>
        <div class="set-row">
          <div class="set-info"><div class="st">API Key（可选）</div><div class="sd">OpenAI 兼容接口需要鉴权时填这里；本机 Ollama 留空。</div></div>
          <input class="input" id="ala-key" type="password" autocomplete="off" style="max-width:240px" placeholder="留空即不带鉴权" value="${esc(c.apiKey || '')}" />
        </div>
      </div>

      <div id="ala-table-box" ${mode === 'table' ? '' : 'hidden'}>
        <div class="set-row">
          <div class="set-info">
            <div class="st">纯查表（极速模式）</div>
            <div class="sd">只答本机数据：最快、不联网、不花一个 token。代价是自由闲聊接不住，只会用固定话术回你。想接模型随时切回来。</div>
          </div>
        </div>
      </div>

      <div class="set-row">
        <div class="set-info">
          <div class="st">联网搜 <span class="tag">默认关</span></div>
          <div class="sd">打开后，问本机数据以外的事（天气、新闻、某个东西是啥），阿刺会先搜一下，再把<b>标题和摘要</b>喂给模型：
            回答里必须说清"这是网上的说法"，参考链接也原样贴给你自己核。<b>搜不到就直说搜不到</b>，不拿旧记忆冒充。
            只抓摘要，不抓正文、不落库、不上传。</div>
        </div>
        <label class="sd" style="display:flex;gap:6px;align-items:center;cursor:pointer;white-space:nowrap">
          <input type="checkbox" id="ala-net-on" ${net.on ? 'checked' : ''}/> 允许联网搜
        </label>
      </div>
      <details class="set-adv" ${net.endpoint ? 'open' : ''}>
        <summary>高级：自定义搜索端点（走内网代理时才需要改）</summary>
        <div class="set-row">
          <div class="set-info"><div class="st">搜索地址</div><div class="sd">留空 = 先用 DuckDuckGo 轻量页，不行再试 Bing。填了就只打你给的地址，可用 <code>{q}</code> 占位。</div></div>
          <input class="input" id="ala-net-endpoint" style="max-width:240px" placeholder="留空即默认" value="${esc(net.endpoint || '')}" />
        </div>
      </details>

      <div class="set-row">
        <div class="set-info">
          <div class="st">朗读 <span class="tag">默认关</span></div>
          <div class="sd">打开后，阿刺自己说的话会念出来（你的话、系统提示不念）。<br/>
            <b>不装任何东西也能用</b>：默认走系统中文语音。想换更好听的音色，才需要本机 MeloTTS-ZH ——
            它只发 Python 库、没有 HTTP 接口，所以得先起一个本地小服务
            （<code>python tools/melo-tts-server.py</code>，默认 127.0.0.1:8899，要装 PyTorch，几百 MB 起）。<br/>
            <b>没起服务不影响功能</b>，只是声音普通些；下面「连通性」显示的是这个可选服务的状态，红了不是软件坏了。</div>
        </div>
        <label class="sd" style="display:flex;gap:6px;align-items:center;cursor:pointer;white-space:nowrap">
          <input type="checkbox" id="ala-tts-on" ${tts.on ? 'checked' : ''}/> 念出回答
        </label>
      </div>
      <details class="set-adv" ${tts.endpoint ? 'open' : ''}>
        <summary>高级：MeloTTS 服务地址与语速</summary>
        <div class="set-row">
          <div class="set-info"><div class="st">服务地址</div><div class="sd">留空 = <code>http://127.0.0.1:8899</code>。端口换过就填你自己的。</div></div>
          <input class="input" id="ala-tts-endpoint" style="max-width:240px" placeholder="留空即默认" value="${esc(tts.endpoint || '')}" />
        </div>
        <div class="set-row">
          <div class="set-info"><div class="st">语速</div><div class="sd">0.5 慢 ~ 2.0 快，默认 1.0。</div></div>
          <input class="input" id="ala-tts-speed" type="number" min="0.5" max="2" step="0.1" style="max-width:90px" value="${tts.speed || 1}" />
        </div>
        <div class="set-row">
          <div class="set-info"><div class="st">连通性</div><div class="sd">点一下看看本机朗读服务通不通。</div></div>
          <div style="display:flex;gap:8px;align-items:center">
            <span id="ala-tts-status" class="chat-tip" style="max-width:240px">未检测</span>
            <button class="btn small" id="ala-tts-probe">检测</button>
            <button class="btn small" id="ala-tts-test">试念一句</button>
          </div>
        </div>
      </details>

      <div class="set-row">
        <div class="set-info">
          <div class="st">动手能力 <span class="tag">接模型后可用</span></div>
          <div class="sd">模型只负责<b>提议</b>：阿刺把要做的事列成卡片，你点「就这么办」才真的落地；要守护密码的照旧要密码；删计划只会降级成「停用」，不删库。
            关掉哪一项，阿刺就不干哪一项；不想挨个关，直接打开<b>只读模式</b>——三项一次全关，退出时恢复你原来的设置。
            <br/>嫌这里深？阿刺面板右上角有个 <b>🖐</b> 按钮，一键切；<b>右键点浮标</b>也能切，不用进设置。</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;font-size:12px">
          <label class="sd" style="display:flex;gap:6px;align-items:center;cursor:pointer;margin-bottom:2px">
            <input type="checkbox" id="ala-cap-ro" ${ro ? 'checked' : ''}/> <b>只读模式</b>（只看不动，下面三项自动关）
          </label>
          <label class="sd" style="display:flex;gap:6px;align-items:center;cursor:pointer${ro ? ';opacity:.45' : ''}">
            <input type="checkbox" id="ala-cap-plan" ${caps.plan ? 'checked' : ''} ${ro ? 'disabled' : ''}/> 制定计划（说「帮我排今天」）
          </label>
          <label class="sd" style="display:flex;gap:6px;align-items:center;cursor:pointer${ro ? ';opacity:.45' : ''}">
            <input type="checkbox" id="ala-cap-edit" ${caps.edit ? 'checked' : ''} ${ro ? 'disabled' : ''}/> 建议更改计划（说「看看我的计划」）
          </label>
          <label class="sd" style="display:flex;gap:6px;align-items:center;cursor:pointer${ro ? ';opacity:.45' : ''}">
            <input type="checkbox" id="ala-cap-msg" ${caps.msg ? 'checked' : ''} ${ro ? 'disabled' : ''}/> 接消息（说「帮我看看消息」）
          </label>
        </div>
      </div>

      <div class="set-row">
        <div class="set-info">
          <div class="st">当前状态</div>
          <div class="sd">模型探测不到时自动用极速应答兜底；切换来源后稍等一两秒会自动重探。</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <span id="ala-status" class="chat-tip" style="max-width:260px">${st}</span>
          <button class="btn small" id="ala-probe">重新探测</button>
        </div>
      </div>
      <div class="set-row">
        <div class="set-info"><div class="st">被警告/禁言时</div><div class="sd">阿刺会主动补一句毒舌提醒（同类 2 分钟内不重复）。</div></div>
      </div>
    </div>`;
}

function bindAlaEnginePanel() {
  const B = window.PQBuddy;
  if (!B || !B.alaCfgApi) return;
  const API = B.alaCfgApi;
  let probeTimer = null;
  const paintStatus = () => {
    const mode = API.mode ? API.mode() : 'qwen';
    const info = B.info().ala;
    const el = $('#ala-status');
    if (!el) return;
    if (mode === 'table') { el.textContent = '⚡ 极速模式（手动选定）'; return; }
    el.textContent = info && info.ok
      ? `🧠 已接上：${info.model}`
      : `⚡ 极速模式（${netReason(info && info.detail)}，先查表兜底）`;
  };
  const afterSave = (probe) => {
    paintStatus();
    const st = $('#ala-status');
    if (st && probe) st.textContent = '⏳ 正在探测模型…';
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      if (probe) API.probe();
      setTimeout(paintStatus, 800);
    }, 350);
  };
  const val = (id) => (($('#' + id) || {}).value || '').trim();

  const readMeituan = () => ({ meituanKey: val('ala-meituan-key') });
  const readMeituanAdv = () => ({ meituanEndpoint: val('ala-meituan-endpoint'), meituanModel: val('ala-meituan-model') });
  const readQwen = () => ({ endpoint: val('ala-qwen-endpoint'), model: val('ala-qwen-model') });
  const readCustom = () => ({ endpoint: val('ala-endpoint'), model: val('ala-model'), kind: (($('#ala-kind') || {}).value || 'ollama'), apiKey: val('ala-key') });

  const boxes = { meituan: '#ala-meituan-box', qwen: '#ala-qwen-box', custom: '#ala-custom-box', table: '#ala-table-box' };
  const syncBoxes = () => {
    const m = (($('#ala-mode') || {}).value || 'qwen');
    Object.keys(boxes).forEach((k) => {
      const el = $(boxes[k]);
      if (el) el.hidden = k !== m;
    });
  };

  const sel = $('#ala-mode');
  if (sel) {
    sel.onchange = () => {
      syncBoxes();
      const m = sel.value;
      const patch = { mode: m };
      if (m === 'meituan') Object.assign(patch, readMeituan(), readMeituanAdv());
      if (m === 'qwen') Object.assign(patch, readQwen());
      if (m === 'custom') Object.assign(patch, readCustom());
      API.set(patch);
      const needKey = m === 'meituan' && !patch.meituanKey;
      afterSave(!needKey);
      const msg = m === 'table' ? '阿刺切到极速模式：快，但话少'
        : m === 'meituan' ? (needKey ? '把美团 LongCat 的 API Key 填上就接上了' : '美团 LongCat 补答')
          : m === 'qwen' ? '本机 Qwen3-4B 补答' : '自定义模型补答';
      toast('模型来源已切换', msg + (m === 'table' ? '' : '；探测不到会自动用极速应答兜底'));
    };
  }

  /* 美团：Key 边输边存，停手 600ms 自动探测 */
  const mk = $('#ala-meituan-key');
  if (mk) {
    mk.oninput = () => {
      if (probeTimer) clearTimeout(probeTimer);
      probeTimer = setTimeout(() => {
        API.set(readMeituan());
        const st = $('#ala-status');
        if (st) st.textContent = mk.value.trim() ? '⏳ 正在验证 Key…' : '⚡ 还没填 Key';
        if (mk.value.trim()) API.probe();
        setTimeout(paintStatus, 1200);
      }, 600);
    };
  }
  const mo = $('#ala-meituan-open');
  if (mo) {
    mo.onclick = () => {
      const url = 'https://longcat.chat/platform';
      try {
        if (window.api && typeof window.api.openExternal === 'function') window.api.openExternal(url);
        else window.open(url, '_blank', 'noreferrer');
      } catch (_) { window.open(url, '_blank', 'noreferrer'); }
      toast('去注册美团 LongCat', '注册完在 API Keys 页复制 default 那个 Key，回来粘贴');
    };
  }
  ['ala-meituan-endpoint', 'ala-meituan-model'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.onchange = () => { API.set(readMeituanAdv()); afterSave(true); };
  });
  ['ala-qwen-endpoint', 'ala-qwen-model'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.onchange = () => { API.set(readQwen()); afterSave(true); };
  });
  ['ala-endpoint', 'ala-model', 'ala-kind', 'ala-key'].forEach((id) => {
    const el = $('#' + id);
    if (el) {
      el.onchange = () => {
        const m = (($('#ala-mode') || {}).value || 'qwen');
        if (m !== 'custom') return;
        API.set(readCustom());
        afterSave(true);
      };
    }
  });

  const probe = $('#ala-probe');
  if (probe) {
    probe.onclick = () => {
      const st = $('#ala-status');
      if (st) st.textContent = '⏳ 正在探测模型…';
      API.probe();
      setTimeout(paintStatus, 1500);
    };
  }

  /* 联网搜开关：默认关；打开后阿刺才会去搜，且只把摘要喂给模型 */
  const netOn = $('#ala-net-on');
  if (netOn && API.setNet) {
    netOn.onchange = () => {
      API.setNet({ on: !!netOn.checked });
      toast(netOn.checked ? '联网搜已打开' : '联网搜已关闭',
        netOn.checked ? '搜到的只是摘要，会标来源；本机数据仍然优先' : '阿刺只答本机数据，不再查网');
    };
  }
  const netEp = $('#ala-net-endpoint');
  if (netEp && API.setNet) {
    netEp.onchange = () => { API.setNet({ endpoint: netEp.value.trim() }); toast('搜索端点已保存', netEp.value.trim() || '已恢复默认（DuckDuckGo → Bing）'); };
  }

  /* 朗读：默认关；开了之后阿刺只念自己说的话（MeloTTS 优先，系统语音兜底） */
  const ttsOnEl = $('#ala-tts-on');
  if (ttsOnEl && API.setTts) {
    ttsOnEl.onchange = () => {
      API.setTts({ on: !!ttsOnEl.checked });
      toast(ttsOnEl.checked ? '朗读已打开' : '朗读已关闭',
        ttsOnEl.checked ? '阿刺的回答会念出来；本地服务没起就用系统中文语音' : '阿刺只出声，不念字');
    };
  }
  const ttsEp = $('#ala-tts-endpoint');
  if (ttsEp && API.setTts) {
    ttsEp.onchange = () => { API.setTts({ endpoint: ttsEp.value.trim() }); toast('朗读地址已保存', ttsEp.value.trim() || '已恢复默认 127.0.0.1:8899'); };
  }
  const ttsSp = $('#ala-tts-speed');
  if (ttsSp && API.setTts) {
    ttsSp.onchange = () => { API.setTts({ speed: Number(ttsSp.value) }); toast('语速已保存', '当前 ' + (Number(ttsSp.value) || 1) + ' 倍'); };
  }
  const ttsSt = $('#ala-tts-status');
  const ttsProbeBtn = $('#ala-tts-probe');
  if (ttsProbeBtn && API.ttsProbe) {
    ttsProbeBtn.onclick = async () => {
      if (ttsSt) ttsSt.textContent = '检测中…';
      const r = await API.ttsProbe();
      if (ttsSt) {
        ttsSt.textContent = r && r.ok
          ? `✅ ${r.model || 'MeloTTS-ZH'} · ${r.endpoint}`
          : `🎙 ${netReason(r && r.detail)} · 改用系统语音，不影响使用`;
      }
    };
  }
  const ttsTestBtn = $('#ala-tts-test');
  if (ttsTestBtn && API.speak) {
    ttsTestBtn.onclick = async () => {
      if (ttsSt) ttsSt.textContent = '正在念…';
      const r = await API.speak('我是阿刺，今天欠的账我记着呢。');
      if (ttsSt) ttsSt.textContent = r && r.ok
        ? (r.via === 'melo' ? '✅ 用的是 MeloTTS-ZH' : '✅ 用的是系统语音（本机服务没开，音色普通但能听）')
        : `⚠️ 念不出来：${netReason(r && r.detail)}`;
    };
  }

  /* 动手能力开关：关掉之后阿刺会直说"这项你关了"，不再自作主张 */
  const roEl = $('#ala-cap-ro');
  if (roEl && API.setCaps) {
    roEl.onchange = () => {
      API.setCaps({ ro: !!roEl.checked });
      if (API.roPaint) API.roPaint();
      toast(roEl.checked ? '只读模式：阿刺只看不动' : '已退出只读，恢复原来的开关',
        roEl.checked ? '接消息 / 排计划 / 改计划已全部关闭' : '按你之前的选择恢复');
      renderSettings();
    };
  }

  [['ala-cap-plan', 'plan'], ['ala-cap-edit', 'edit'], ['ala-cap-msg', 'msg']].forEach(([id, key]) => {
    const el = $('#' + id);
    if (!el) return;
    el.onchange = () => {
      if (API.setCaps) API.setCaps({ [key]: !!el.checked });
      const name = { plan: '排计划', edit: '改计划', msg: '接消息' }[key];
      toast(el.checked ? `已开启：${name}` : `已关闭：${name}`, el.checked ? '阿刺会先提议，你点头才动手' : '阿刺不会再碰这一项');
    };
  });

  syncBoxes();
}

/* 毒舌提醒钩子：被警告/禁言/拦截时叫阿刺补一句（同类 2 分钟内不重复） */
function alaScold(kind, detail) {
  try { if (window.PQBuddy && PQBuddy.scold) PQBuddy.scold(kind, detail); } catch (_) {}
}

/* 设置页：AI 自训练面板 */
function aiTrainPanelHTML() {
  const T = window.AITrain;
  if (!T) return '';
  const i = T.info();
  const c = i.counts;
  const fg = window.FlipGuard ? FlipGuard.status() : null;
  const pool = window.FlipGuard ? FlipGuard.pendingList().slice(0, 5) : [];
  const audits = window.FlipGuard ? FlipGuard.audit(6) : [];
  const fmt = (t) => (t ? new Date(t).toLocaleDateString('zh-CN') : '');
  const sel = (kind, cur, list) => `
    <select class="select" id="ai-tr-${kind}-sel" style="max-width:230px">
      <option value="official" ${cur === 'official' ? 'selected' : ''}>官方模型（预置）</option>
      ${list
        .map(
          (m) =>
            `<option value="${m.id}" ${cur === m.id ? 'selected' : ''}>${esc(m.name)} ${fmt(m.at)} · ${Math.round(m.acc * 100)}%</option>`
        )
        .join('')}
    </select>`;
  const cur = (m, extra) =>
    m ? `<b>${esc(m.name)}</b> · 样本 ${m.n} · 训练集 ${Math.round(m.acc * 100)}%${m.hold != null ? ` · 留出验证 ${Math.round(m.hold * 100)}%` : ''}${extra || ''}` : '<b>官方模型</b> · 出厂预置';
  return `
    <div class="panel">
      <h3>AI 自训练 <span class="tag">本地训练</span></h3>
      <div class="sd" style="margin:4px 0 12px">
        「闲聊雷达」和「画面盯学」现在都是<b>强制开启</b>，不给关。它们不是死的：
        你可以纠正它的判断（点聊天里的 🐟/📖 徽章、抓包后在房间里回答「刚才真在摸鱼吗」），
        攒够样本后在下面训练<b>自己的模型</b>，随时可以切回官方模型。
        全部在本机训练，模型权重只有几 KB。
      </div>

      <div class="ai-tr-grid">
        <div class="ai-tr-card">
          <div class="ai-tr-t">💬 闲聊雷达</div>
          <div class="ai-tr-n">文字样本 <b>${c.text}</b> 条（闲聊 ${c.textFish} / 正经 ${c.text - c.textFish}）</div>
          <div class="ai-tr-m">${cur(i.text.model)}</div>
          <div class="ai-tr-act">
            <button class="btn small" id="ai-tr-text">训练文字模型</button>
            ${sel('text', i.text.active, T.modelList('text'))}
          </div>
          <div class="ai-tr-hint">冻结官方语义特征，只重训最后一层（约 1 秒）</div>
        </div>
        <div class="ai-tr-card">
          <div class="ai-tr-t">📷 画面盯学</div>
          <div class="ai-tr-n">画面样本 <b>${c.image}</b> 条（摸鱼 ${c.imageFish} / 认真 ${c.image - c.imageFish}）</div>
          <div class="ai-tr-m">${cur(i.image.model, i.image.model && i.image.model.w ? ` · T=${i.image.model.w.T} b=${i.image.model.w.b}` : '')}</div>
          <div class="ai-tr-act">
            <button class="btn small" id="ai-tr-image">训练画面校准</button>
            ${sel('image', i.image.active, T.modelList('image'))}
          </div>
          <div class="ai-tr-hint">整只 CNN 无法在手机/浏览器里重训，这里学的是「温度 + 阈值」校准</div>
        </div>
      </div>

      <div class="ai-tr-row">
        <label class="ai-tr-chk"><input type="checkbox" id="ai-tr-cloud" ${i.cfg.cloud ? 'checked' : ''}/> 允许云端同步训练集（按账号隔离，仅登录后生效）</label>
        <label class="ai-tr-chk"><input type="checkbox" id="ai-tr-shared" ${i.cfg.shared ? 'checked' : ''}/> 参与公共训练集（匿名，仅文字与数值，不含画面）</label>
        <button class="btn small ghost" id="ai-tr-sync">立即同步</button>
      </div>
      <div class="ai-tr-msg" id="ai-tr-msg">${i.lastSync ? '上次同步：' + new Date(i.lastSync).toLocaleString('zh-CN') : '还没同步过 · 未登录时训练集只存本机'}</div>
      <div class="sd" style="margin:10px 0 0;opacity:.75">
        模型来源与许可：画面模型 MobileNetV3-Small（BSD-3）· 文字编码器 gte-small-zh（Apache-2.0）·
        语音识别 Vosk 小模型 + vosk-browser（Apache-2.0）· 推理 ONNX Runtime（MIT）。
        早期画面模型来自 Mind+/YOLOv8（AGPL-3.0），已为规避许可传染整体替换；
        完整清单见安装目录「开源许可声明.txt」。
      </div>
      <div class="ai-tr-pool" style="margin-top:14px;border-top:1px dashed var(--line);padding-top:12px">
        <div class="ai-tr-t">🛡 翻案候选池 ${
          fg ? `<span class="tag">信用 ${fg.score} · ${fg.tier}</span>` : '<span class="tag">风控未加载</span>'
        }</div>
        <div class="sd" style="margin:4px 0 8px">
          ${
            fg
              ? `今日翻案 <b>${fg.used}/${fg.quota}</b> · 权重 <b>${fg.weight}</b> · 待确认 <b>${fg.pending}</b> 条 · 已采纳 ${fg.confirmed} · 观察 ${fg.probation || 0} · 已回滚 ${fg.rolledback}` +
                (fg.locked ? ' · 🔒 <b>今日已锁定</b>' : '')
              : '翻案风控模块未加载'
          }
          <br/>规则：双击（或长按）徽章 → 选理由 → 信用「良好」以上才直接采纳，其余进候选池；
          候选池需<b>冷静 30 分钟后二次确认</b>，或由<b>另一条相似内容的同向翻案佐证</b>，才进训练集。
          候选 / 回滚的样本不参与训练、不上传云端。
          ${
            fg && fg.rookie
              ? `<br/><b>🐣 新手期还剩 ${fg.rookieLeft} 天</b>：这期间翻的案照常改判（只在本机生效），
                 但样本记入「观察」，<b>不进训练池、不上传</b> —— 先熟悉判断口径，再当教材。
                 观察样本<b>不会自动转正</b>，过新手期后新的翻案才正常进训练集。`
              : ''
          }
        </div>
        ${
          pool.length
            ? pool
                .map((f) => {
                  const to = f.to ? '闲聊' : '正经事';
                  const wait = f.cooled ? '' : ` · 冷静期还剩 ${f.waitMin} 分钟`;
                  return `<div class="ai-tr-poolrow" data-fid="${f.id}" style="display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--line)">
                    <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                      ${f.kind === 'image' ? '📷' : '💬'} ${f.rookie ? '🐣 ' : ''}${esc(String(f.text || '').slice(0, 26))}
                      <span class="chat-tip">→ ${to} · ${esc(f.reason)} · 权重 ${f.weight}${wait}${f.peer ? ' · 已有相似佐证' : ''}${
                        f.votes && (f.votes.yes || f.votes.no) ? ` · 房间票 认可 ${f.votes.yes} / 不认可 ${f.votes.no}` : ''
                      }</span>
                    </span>
                    <button class="btn small ghost" data-fgc="${f.id}" ${f.canConfirm ? '' : 'disabled'}>确认</button>
                    <button class="btn small ghost" data-fgr="${f.id}">驳回</button>
                  </div>`;
                })
                .join('')
            : '<div class="sd">暂无待确认翻案。</div>'
        }
        <div class="ai-tr-act" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn small ghost" id="fg-purge">清理已回滚记录</button>
          <button class="btn small ghost" id="fg-reset">清空本机翻案记录</button>
          <span class="chat-tip">样本池 ${c.pool || 0} 条待确认 · ${c.rolledback || 0} 条已回滚${c.probation ? ` · ${c.probation} 条新手观察（不训练）` : ''}</span>
        </div>
        ${
          audits.length
            ? `<div class="sd" style="margin-top:8px;line-height:1.7;opacity:.8">最近审计：${audits
                .map((a) => `${new Date(a.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} ${a.kind === 'image' ? '📷' : '💬'}→${a.to ? '闲聊' : '正经事'} ${a.status}${a.auto ? '(自动)' : ''}`)
                .join(' · ')}</div>`
            : ''
        }
      </div>

      <div class="ai-tr-foot">
        <span class="chat-tip">待上传 ${c.pending} 条</span>
        <button class="btn small ghost" id="ai-tr-clear-text">清空文字样本</button>
        <button class="btn small ghost" id="ai-tr-clear-image">清空画面样本</button>
        <button class="btn small ghost" id="ai-tr-delmodel">删除当前模型</button>
      </div>
    </div>`;
}

/* PK 布告栏：私有 GitHub 仓库（一个军团一个文件，主备双写）
   设置只属于军团主 —— 仓库和 token 都在这台机器上，成员不需要也不该看到。 */
function pkRepoPanelHTML() {
  const L = window.PQLegion ? PQLegion.info() : null;
  const joined = !!(L && L.joined);
  const isOwner = !!(L && L.role === 'host');
  if (joined && !isOwner) {
    return `<div class="panel"><h3>军团 PK 布告栏</h3>
      <div class="sd">布告栏由军团主设置（仓库地址与 token 只存在他的电脑上）。成员不用配置，跟着军团主的配对结果走。</div>
    </div>`;
  }
  const p = (state.settings && state.settings.pkRepo) || {};
  const bak = p.backup || {};
  return `
    <div class="panel">
      <h3>军团 PK 布告栏</h3>
      <div class="sd" style="margin-bottom:10px;opacity:.85">
        布告栏是<b>你自己的私有仓库</b>：一个军团一个文件，各写各的，不会出现「最后写的人覆盖前面 49 个人」。
        上传的只有聚合数字（军团码 / 人数 / 每日出操率），没有名字、没有计划、没有积分。
        写回带签名与主备双写，被改了能验出来，也能从每小时的快照回滚。
      </div>
      <div class="set-row"><div class="set-info"><div class="st">仓库</div><div class="sd">格式：用户名/仓库名，例如 wya/pq-board。私有仓库，只在军团主的电脑上填。</div></div></div>
      <div class="lg-fields">
        <input class="input" id="pk-owner" placeholder="owner（用户名）" value="${esc(p.owner || '')}" />
        <input class="input" id="pk-repo" placeholder="repo（仓库名）" value="${esc(p.repo || '')}" />
        <input class="input" id="pk-branch" placeholder="分支（默认 main）" value="${esc(p.branch || 'main')}" />
      </div>
      <div class="set-row" style="margin-top:14px"><div class="set-info"><div class="st">GitHub 授权</div><div class="sd">用官方 OAuth 登录：点一下 → 浏览器里输一次 6 位码 → 完成。不用去后台生成 token，也不用手动粘贴。<br/>只有你点按钮才会登录——软件不会自己去连 GitHub。</div></div></div>
      <div class="lg-actions" style="margin-top:8px">
        ${p.oauthAt ? `<span class="lg-chip">已授权 ${esc(p.tokenMask || '')}</span>` : ''}
        <button class="btn" id="pk-oauth-login" type="button">${p.oauthAt ? '重新授权' : '用 GitHub 登录'}</button>
        ${p.oauthAt ? '<button class="btn ghost" id="pk-oauth-out" type="button">退出登录</button>' : ''}
        <button class="btn ghost" id="pk-token-auto" type="button">检测本机凭据</button>
      </div>
      <div id="pk-oauth-code" class="sd" style="margin-top:8px;display:none"></div>
      <div class="sd" id="pk-token-state" style="margin-top:6px">正在读取授权状态…（不会去碰系统凭据助手）</div>
      <details style="margin-top:8px">
        <summary class="sd" style="cursor:pointer">还没有 OAuth App？点这里看一次性配置</summary>
        <div class="sd" style="margin-top:6px;line-height:1.7">
          1. 打开 <a href="#" id="pk-oauth-app-link">GitHub → Settings → Developer settings → OAuth Apps</a>，点 New OAuth App；<br>
          2. 名字随便填（例如 PlanQuest），Homepage 填 <code>https://example.com</code>，<b>回调地址留空</b>；<br>
          3. 建好后勾上 <b>Enable Device Flow</b>，把 <b>Client ID</b> 复制到下面。<br>
          4. Client ID 是公开信息，不是密钥；它只代表「哪个应用在申请授权」，授权范围仍由你在浏览器里确认。
        </div>
        <div class="lg-fields" style="margin-top:8px">
          <input class="input" id="pk-oauth-client" placeholder="OAuth App 的 Client ID（例如 Iv1.xxxxxxxx）" value="${esc(p.oauthClientId || '')}" />
          <button class="btn ghost" id="pk-oauth-save" type="button">保存</button>
        </div>
      </details>
      <details style="margin-top:8px">
        <summary class="sd" style="cursor:pointer">高级：手动填 token（不推荐）</summary>
        <div class="lg-fields" style="margin-top:8px">
          <input class="input" id="pk-token" type="password" placeholder="${p.hasToken ? 'token 已保存，留空表示不改' : '也可以直接粘一个 token'}" />
        </div>
      </details>
      <div class="set-row" style="margin-top:12px"><div class="set-info"><div class="st">备仓（可选）</div><div class="sd">再填一个仓库，写入时两边都写、读取时两边对比；不一致会告警。不填就只用主仓 + 每小时快照。</div></div></div>
      <div class="lg-fields">
        <input class="input" id="pk-bak-owner" placeholder="备仓 owner" value="${esc(bak.owner || '')}" />
        <input class="input" id="pk-bak-repo" placeholder="备仓 repo" value="${esc(bak.repo || '')}" />
        <input class="input" id="pk-bak-branch" placeholder="备仓分支" value="${esc(bak.branch || 'main')}" />
      </div>
      <div class="lg-actions" style="margin-top:10px">
        <button class="btn" id="pk-save">保存布告栏</button>
        <span class="chat-tip">token 只存在本机；导出的备份文件里也不会带 token</span>
      </div>
    </div>`;
}

function bindAiTrainPanel() {
  const T = window.AITrain;
  if (!T) return;
  const msg = $('#ai-tr-msg');
  const say = (t, warn) => {
    if (!msg) return;
    msg.textContent = t;
    msg.classList.toggle('warn', !!warn);
  };
  const refresh = () => {
    if (currentView === 'settings') renderSettings();
  };

  const cloud = $('#ai-tr-cloud');
  if (cloud) {
    cloud.onchange = (e) => {
      T.setConfig({ cloud: e.target.checked });
      say(e.target.checked ? '已允许云端同步：下次点「立即同步」会把训练集传到你的云账号' : '已关闭云端同步，训练集只存本机');
    };
  }

  const shared = $('#ai-tr-shared');
  if (shared) {
    shared.onchange = async (e) => {
      if (!e.target.checked) {
        T.setConfig({ shared: false });
        say('已退出公共训练集');
        return;
      }
      const ok = await confirmDialog(
        '参与公共训练集？',
        '你标注的文字样本、画面判定的数值（不含摄像头画面）会匿名共享给同样开启该选项的用户，同时你也会拉到公共样本一起训练。样本可能包含错误或恶意标注，介意就别开。'
      );
      if (!ok) {
        e.target.checked = false;
        return;
      }
      T.setConfig({ shared: true, cloud: true });
      say('已参与公共训练集：下次同步会匿名上传，并拉取公共样本');
      refresh();
    };
  }

  const sync = $('#ai-tr-sync');
  if (sync) {
    sync.onclick = async () => {
      sync.disabled = true;
      say('正在同步训练集…');
      try {
        const r = await T.sync();
        say(r.message, !r.ok);
        if (r.ok) toast('☁ 训练集已同步', r.message);
      } catch (err) {
        say('同步失败：' + (err.message || err), true);
      }
      sync.disabled = false;
      refresh();
    };
  }

  const textBtn = $('#ai-tr-text');
  if (textBtn) {
    textBtn.onclick = async () => {
      textBtn.disabled = true;
      textBtn.textContent = '训练中…';
      say('正在提取句向量…');
      try {
        const r = await T.trainText((i, n) => say(`正在提取句向量 ${i}/${n}…`));
        if (!r.ok) say(r.message, true);
        else {
          T.setActive('text', r.model.id);
          const h = r.after.hold == null ? '' : ` · 留出验证 ${Math.round(r.after.hold * 100)}%`;
          say(
            `训练完成：训练集 ${Math.round(r.after.acc * 100)}%${h}（同一批数据上官方为 ${Math.round(
              r.before.accTrain * 100
            )}%），已切到「${r.model.name}」`
          );
          toast('💬 文字模型训练完成', `样本 ${r.model.n} 条 · 已自动切换到新模型`);
          /* 离线评估兜底：留出验证集偏低 = 候选池里可能混着错标，先别训练太自信 */
          if (r.after.hold != null && r.after.hold < 0.6) {
            say(`⚠️ 留出验证只有 ${Math.round(r.after.hold * 100)}%：训练集可能掺了错标，建议先到下方「翻案候选池」清理再过一遍`, true);
          }
        }
      } catch (err) {
        say('训练失败：' + (err.message || err), true);
      }
      textBtn.disabled = false;
      refresh();
    };
  }

  const imgBtn = $('#ai-tr-image');
  if (imgBtn) {
    imgBtn.onclick = () => {
      try {
        const r = T.trainImage();
        if (!r.ok) return say(r.message, true);
        T.setActive('image', r.model.id);
        say(
          `画面校准完成：准确率 ${Math.round(r.before.acc * 100)}% → ${Math.round(r.after.acc * 100)}%（T=${r.T.toFixed(
            2
          )}, b=${r.b.toFixed(2)}），已切到「${r.model.name}」`
        );
        toast('📷 画面校准完成', `样本 ${r.model.n} 条 · 判定阈值已按你的习惯调整`);
      } catch (err) {
        say('训练失败：' + (err.message || err), true);
      }
      refresh();
    };
  }

  ['text', 'image'].forEach((kind) => {
    const el = $(`#ai-tr-${kind}-sel`);
    if (!el) return;
    el.onchange = () => {
      T.setActive(kind, el.value);
      const name = el.value === 'official' ? '官方模型' : '我的模型';
      toast('已切换模型', `${kind === 'text' ? '闲聊雷达' : '画面盯学'} 现在用「${name}」，立即生效`);
    };
  });

  const ct = $('#ai-tr-clear-text');
  if (ct) {
    ct.onclick = async () => {
      if (!(await confirmDialog('清空文字样本？', '本机保存的文字训练样本会全部删除（云端已上传的不会删）。'))) return;
      T.clearSamples('text');
      say('文字样本已清空');
      refresh();
    };
  }
  const ci = $('#ai-tr-clear-image');
  if (ci) {
    ci.onclick = async () => {
      if (!(await confirmDialog('清空画面样本？', '本机保存的画面校准样本会全部删除（云端已上传的不会删）。'))) return;
      T.clearSamples('image');
      say('画面样本已清空');
      refresh();
    };
  }
  const dm = $('#ai-tr-delmodel');
  if (dm) {
    dm.onclick = () => {
      const a = T.info();
      const cur = a.text.active !== 'official' ? a.text : a.image.active !== 'official' ? a.image : null;
      if (!cur) return toast('当前就是官方模型', '', false);
      const m = cur.model;
      if (!m) return;
      T.removeModel(m.id);
      say(`已删除「${m.name}」，回到官方模型`);
      refresh();
    };
  }

  /* ---- 翻案候选池 ---- */
  if (!window.FlipGuard) return;
  document.querySelectorAll('[data-fgc]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.fgc;
      const r = FlipGuard.confirm(id);
      if (!r.ok) return toast('还不能确认', r.message, true);
      if (r.sampleId) T.setSampleStatus(r.sampleId, r.status || 'confirmed');
      applyConfirmedFlip(id);
      syncFlipContext();
      toast(
        r.rookie ? '✅ 翻案已确认（新手期）' : '✅ 翻案已确认',
        r.rookie
          ? '改判已生效，但这一条只记入观察 —— 新手期翻的案不进训练集、不上传云端'
          : r.via === 'room'
            ? '房间其他同学已认可（取多数），样本已进训练集'
            : r.via === 'peer'
              ? '已有相似翻案佐证，样本已进训练集'
              : '冷静期满，二次确认通过，样本已进训练集'
      );
      creditEvt('flip_ok', r.via === 'room' ? '翻案经房间认可' : r.via === 'peer' ? '翻案经相似佐证核实' : '翻案冷静期复核通过');
      refresh();
    };
  });
  document.querySelectorAll('[data-fgr]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.fgr;
      const r = FlipGuard.reject(id);
      if (r.ok && r.sampleId) T.setSampleStatus(r.sampleId, 'rollback');
      toast('已驳回', '该翻案作废，样本不进训练集');
      refresh();
    };
  });
  const fgPurge = $('#fg-purge');
  if (fgPurge) {
    fgPurge.onclick = () => {
      const r = FlipGuard.purgeRolledBack();
      toast('已清理回滚记录', `移除 ${r.removed} 条审计（已回滚样本本来就不进训练集）`);
      refresh();
    };
  }
  const fgReset = $('#fg-reset');
  if (fgReset) {
    fgReset.onclick = async () => {
      if (!(await confirmDialog('清空本机翻案记录？', '审计日志与候选池会清空（已进训练集的样本不受影响）。'))) return;
      FlipGuard.resetAll();
      toast('翻案记录已清空', '今日名额也会重置 —— 这是「自己去毒」，别拿来刷名额');
      refresh();
    };
  }
}

/* 候选池确认后，把聊天气泡上挂着的「待确认」真正改成新标签 */
function applyConfirmedFlip(flipId) {
  const info = window.FlipGuard ? FlipGuard.audit(300).find((f) => f.id === flipId) : null;
  if (!info || info.kind !== 'text') return;
  const m = chatLog.find((x) => x && x.ai && x.ai.pending != null && String(x.text || '') === info.text);
  if (!m) return;
  m.ai = { label: info.to ? 'fish' : 'work', p: info.to ? 0.99 : 0.01, fixed: true };
  patchChatBadge(m);
}

/* ---- 聊天渲染 ---- */

/* 房间里的 @ 名单：在场的房间成员（去掉「（我）」后缀）+ 自己 */
function roomRoster() {
  const me = (state && state.profile && state.profile.name) || '我';
  const out = [{ uid: 'me', alias: me }];
  for (const m of roomMembers || []) {
    const nm = String((m && m.name) || '').replace(/（我）$/, '').trim();
    if (!nm || nm === me) continue;
    if (out.some((x) => x.alias === nm)) continue;
    out.push({ uid: (m && m.id) || nm, alias: nm });
  }
  return out;
}

/* 房间聊天里的 pq:// 链接：认得出来就给个按钮，认不出来就是一行字 */
function roomChatText(m, roster) {
  const lib = window.PQLegionChat;
  const body = String((m && m.text) || '');
  if (!lib) return esc(body);

  const linkHtml = (txt) => {
    if (!lib.splitLinks || !/pq:\/\//i.test(txt)) return esc(txt);
    return lib
      .splitLinks(txt)
      .map((seg) => {
        if (!seg.link) return esc(seg.text);
        if (seg.link.kind === 'room') {
          return `<button class="btn small ghost" data-room="${esc(seg.link.ip)}|${Number(seg.link.port) || 0}|${esc(seg.link.code)}">🏠 进房间 ${esc(seg.link.code)}</button>`;
        }
        if (seg.link.kind === 'pk') {
          const rawPk = encodeURIComponent(JSON.stringify(seg.link));
          return `<button class="btn small pk-challenge" data-pk="${esc(rawPk)}">⚔️ 应战 ${esc(seg.link.name)}（战力 ${Number(seg.link.rate) || 0}）</button>`;
        }
        const raw = encodeURIComponent(JSON.stringify(seg.link));
        return `<button class="btn small ghost" data-legion="${esc(raw)}">🛡 加入军团 ${esc(seg.link.code)}</button>`;
      })
      .join('');
  };

  /* 先切 @（只做切段与转义，不拼裸 HTML），剩下的每段再找 pq:// 链接 */
  const segs = lib.splitMentions ? lib.splitMentions(body, roster || []) : [{ text: body, at: false }];
  return segs.map((p) => (p.at ? `<span class="lgc-at">${esc(p.text)}</span>` : linkHtml(p.text))).join('');
}

/* 计划包附件：合并导入，不覆盖本机数据 */
function roomAttachHTML(m) {
  const lk = m && m.link;
  if (!lk || lk.kind !== 'plan') return '';
  return `<div class="lgc-link plan">
      <div class="lgc-link-t">📋 计划包 · <b>${esc(lk.name || '计划')}</b> · ${Number(lk.count) || 0} 个计划</div>
      <button class="btn small" data-planid="${esc(m.id || '')}">预览导入</button>
    </div>`;
}

async function importRoomPlan(b) {
  if (!b) return;
  const id = b.getAttribute('data-planid');
  const msg = (chatLog || []).find((m) => m && m.id === id);
  if (!msg || !msg.link || msg.link.kind !== 'plan') return toast('附件丢了', '让发的人再发一次', true);
  b.disabled = true;
  b.textContent = '预览中…';
  await openPlanPreview(msg.link.text, msg.uid || '', msg.from || msg.alias || '');
  b.disabled = false;
  b.textContent = '预览导入';
}

/* .pqplan 安全四件套：预览（二次确认 + 来源标记）→ 24h 沙箱 → 手动转正 / 直接删 */
async function openPlanPreview(text, from, fromAlias) {
  let p = null;
  try {
    p = await api.planPreview({ text, from, fromAlias });
  } catch (_) {
    return toast('预览失败', '这台设备不支持计划包预览', true);
  }
  if (!p || !p.ok) {
    toast(p && p.blocked ? '计划包已拦截' : '预览失败', (p && p.message) || '', true);
    if (p && p.blocked) alaScold('planban', (p && p.message) || '来路不明的计划文件');
  }
  const pv = p.preview || {};
  const risk = pv.risk === 'high' ? '⚠️ 押金或惩罚高得离谱，谨慎导入' : pv.risk === 'mid' ? '⚠️ 注意押金与惩罚力度' : '';
  const lines = [
    p.sourceText || '来源不明',
    `${pv.plans || 0} 个计划 · ${pv.contracts || 0} 个契约 · 押金合计 ¥${pv.deposit || 0}`,
    `积分规则：奖 ${pv.pointsRules?.reward || 0} 分 / 罚 ${pv.pointsRules?.penalty || 0} 分`,
    risk,
    (pv.items || []).slice(0, 8).map((x) => `· ${x.title}（${x.kind}${x.remind ? ' · ' + x.remind : ''}）`).join('\n'),
    pv.hidden ? `…还有 ${pv.hidden} 个没列出来` : '',
    '确认导入后先进 24 小时沙箱：积分变动和契约执行都是虚拟的，不影响主计划；没问题再手动转正，有问题直接删。',
  ].filter(Boolean);
  if (!(await confirmDialog('计划预览（二次确认）', lines.join('\n')))) return;
  try {
    const r = await api.planfileImportText({ text, from, fromAlias });
    if (r && r.ok) toast('已进沙箱', r.message || '24 小时内没问题再转正');
    else {
      toast(r && r.blocked ? '计划包已拦截' : '导入失败', (r && r.message) || '', true);
      if (r && r.blocked) alaScold('planban', (r && r.message) || '来路不明的计划文件');
    }
  } catch (_) {
    toast('导入失败', '稍后再试', true);
  }
}

function renderChat(stick) {
  const list = $('#chat-list');
  if (!list) return;
  // 用户是否本来就在底部附近（60px 内）→ 只有这种情况才自动跟到底，
  // 否则保留阅读位置，不要「往下一拽」
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const follow = typeof stick === 'boolean' ? stick : nearBottom;
  const prevTop = list.scrollTop;
  if (!chatLog.length) {
    list.innerHTML = '<div class="chat-empty">还没有人说话，打个招呼吧 👋</div>';
    return;
  }
  const roster = roomRoster();
  const meName = (state && state.profile && state.profile.name) || '我';
  list.innerHTML = chatLog
    .slice(-60)
    .map((m) => {
      if (m.sys) return `<div class="chat-line sys">${esc(m.text)}</div>`;
      const t = new Date(m.at || Date.now());
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const atMe =
        m.from !== meName && !!window.PQLegionChat && window.PQLegionChat.mentionsMe(m.text, meName);
      return `<div class="chat-line${atMe ? ' atme' : ''}" data-cid="${esc(m.id || '')}"><span class="chat-av">${esc(m.avatar || '🙂')}</span>
        <div class="chat-body"><span class="chat-who">${esc(m.from || '同学')}</span>
        <span class="chat-time">${hh}:${mm}</span>${atMe ? '<span class="lgc-at-me">@ 你</span>' : ''}
        <div class="chat-text">${roomChatText(m, roster)}${roomAttachHTML(m)}<span class="chat-badge-slot">${chatBadgeHtml(m)}</span>${
          m.memberId && m.memberId !== (state?.room?.myId || '') && m.from
            ? `<span class="chat-tools" style="margin-left:6px;white-space:nowrap">
                <button class="btn small ghost" data-thanks="${esc(m.from)}" title="这人有帮助？感谢一下（联盟贡献）">🙏</button>
                <button class="btn small ghost" data-report="${esc(m.from)}" title="举报广告/骚扰/挂机（需房内 3 人）">🚩</button></span>`
            : ''
        }${
          (() => {
            const v = /^🛡 翻案待复核 #([a-z0-9]+)：/i.exec(String(m.text || ''));
            if (!v || m.memberId === (state?.room?.myId || '')) return '';
            return `<span class="flip-vote" style="margin-left:6px;white-space:nowrap">
              <button class="btn small ghost" data-vote="${v[1]}:agree">认可</button>
              <button class="btn small ghost" data-vote="${v[1]}:deny">不认可</button></span>`;
          })()
        }</div></div></div>`;
    })
    .join('');
  if (follow) list.scrollTop = list.scrollHeight;
  else list.scrollTop = Math.min(prevTop, Math.max(0, list.scrollHeight - list.clientHeight));
}

/* @ 未读：只在标题上记个数，不发「已读回执」——别人不知道你看没看 */
function paintChatUnread() {
  const el = $('#chat-unread');
  if (!el) return;
  el.textContent = String(chatUnreadAt);
  el.hidden = !chatUnreadAt;
}

function bumpMentionUnread(msg) {
  if (!msg || msg.sys) return;
  const meName = (state && state.profile && state.profile.name) || '我';
  const mine = msg.from === meName || msg.memberId === (state?.room?.myId || '');
  if (mine) return;
  if (!window.PQLegionChat || !window.PQLegionChat.mentionsMe(msg.text, meName)) return;
  chatUnreadAt += 1;
  paintChatUnread();
}

function pushChat(msg) {
  if (!msg) return;
  chatLog.push(msg);
  if (chatLog.length > 200) chatLog = chatLog.slice(-200);
  // 自己发的消息总是跟到底部；别人发的只有在用户本来就在底部时才跟随
  const list = $('#chat-list');
  const mine = msg.from === (state?.profile?.name || '我') || msg.memberId === (state?.room?.myId || '');
  const stick = mine || !list || (list.scrollHeight - list.scrollTop - list.clientHeight < 60);
  renderChat(stick);
  bumpMentionUnread(msg);
  notifyRoomMsg(msg, mine); // 微信式弹窗：不在这个房间时弹一条
  classifyChat(msg); // AI 闲聊雷达：异步判定后回写徽章
  handleRoomVoteMsg(msg);
  handleReputationMsg(msg);
}

/* 联机诚信与互助：感谢、举报、举报属实回执 */
function handleReputationMsg(msg) {
  const text = String((msg && msg.text) || '').trim();
  const me = state?.profile?.name || '我';
  const mine = msg.memberId && msg.memberId === (state?.room?.myId || '');

  /* 别人感谢我 → 联盟贡献 +2（对方点了按钮 = 对方确认） */
  const t = /^🙏 感谢 @(.+)$/.exec(text);
  if (t && !mine && t[1].trim() === me) {
    creditEvt('help_ok', '房间答疑/帮助被同学确认');
    toast('🙏 有人感谢了你的帮助', '联盟贡献 +2（每天有上限）');
    return;
  }

  /* 我被举报 → 房内 ≥3 位不同同学 → 自己记账（-10，进入失信观察） */
  const r = /^🚩 举报 @([^：:]+)[：:](.*)$/.exec(text);
  if (r && r[1].trim() === me && !mine) {
    const st = reportState();
    const tgt = (st.targets[me] = st.targets[me] || { reporters: [], reasons: [] });
    const who = msg.memberId || msg.from || 'anon';
    if (!tgt.reporters.includes(who)) tgt.reporters.push(who);
    tgt.reasons.push(String(r[2] || '').slice(0, 30));
    saveReportState(st);
    if (tgt.reporters.length >= 3 && !tgt.settled) {
      tgt.settled = true;
      saveReportState(st);
      api.creditEvent({ type: 'online_bad', note: `被 ${tgt.reporters.length} 位同学举报并核实（${tgt.reasons.slice(0, 2).join('、')}）` }).catch(() => {});
      api.roomChat(`✅ 举报属实：${tgt.reasons.slice(0, 2).join('、') || '违规行为'}（已记账）`).catch(() => {});
      toast('🚩 你被房内核实举报', '信誉分 -2 起，注意摄像头前的行为', true);
    }
    return;
  }

  /* 举报属实回执 → 曾经举报过我的人加分（只认自己发过的举报） */
  const ok = /^✅ 举报属实/.exec(text);
  if (ok && !mine) {
    const st = reportState();
    Object.keys(st.mine || {}).forEach((name) => {
      st.mine[name].ok = (st.mine[name].ok || 0) + 1;
      st.hist.push({ at: Date.now(), ok: true, target: name });
    });
    saveReportState(st);
    creditEvt('report_ok', '举报经核实属实');
  }
}

/* 房间公投回执：🛡 复核意见 #<flipId>:agree / deny —— 取多数，≥1 认可即转正 */
function handleRoomVoteMsg(msg) {
  const m = /^🛡 复核意见 #([a-z0-9]+):(agree|deny)/i.exec(String((msg && msg.text) || '').trim());
  if (!m || !window.FlipGuard || !window.AITrain) return;
  const me = (state && state.room && state.room.myId) || '';
  const voter = msg.memberId || msg.from || 'anon';
  if (voter && voter === me) return; // 自己那一票不算
  const r = FlipGuard.addPeerVote(m[1], voter, m[2] === 'agree');
  if (!r.ok) return;
  if (r.status === 'rollback') {
    const info = FlipGuard.audit(300).find((f) => f.id === m[1]);
    if (info && info.sampleId) AITrain.setSampleStatus(info.sampleId, 'rollback');
    toast('🛡 房间复核：翻案被否', `认可 ${r.yes} · 不认可 ${r.no}，样本已作废`, true);
    creditEvt('flip_bad', '翻案被房间多数否决');
  } else if (r.yes >= 1 && r.yes > r.no) {
    const c = FlipGuard.confirm(m[1]);
    if (c.ok) {
      if (c.sampleId) AITrain.setSampleStatus(c.sampleId, c.status || 'confirmed');
      applyConfirmedFlip(m[1]);
      toast(
        c.rookie ? '✅ 房间同学认可了这条翻案（新手期）' : '✅ 房间同学认可了这条翻案',
        c.rookie
          ? `认可 ${r.yes} · 不认可 ${r.no}，改判生效，但新手期样本只记观察、不进训练集`
          : `认可 ${r.yes} · 不认可 ${r.no}，样本已进训练集`
      );
      creditEvt('flip_ok', '翻案经房间同学认可（众包核实）');
    }
  } else {
    toast('🛡 房间复核收到一票', `认可 ${r.yes} · 不认可 ${r.no}`);
  }
  if (currentView === 'settings') renderSettings();
}

/* 联机稳定在线：在房间里待满 30 分钟记一次联盟贡献（换行/断线不计，后端每日上限 2） */
let onlineTickTimer = null;
let onlineSince = 0;
function startOnlineCredit() {
  if (onlineTickTimer) clearInterval(onlineTickTimer);
  onlineSince = Date.now();
  onlineTickTimer = setInterval(() => {
    if (!roomJoined) {
      clearInterval(onlineTickTimer);
      onlineTickTimer = null;
      return;
    }
    creditEvt('online_ok', `联机稳定在线 ${Math.round((Date.now() - onlineSince) / 60000)} 分钟`);
    onlineSince = Date.now();
  }, 30 * 60 * 1000);
}

/* ---- 娱乐房 / 禁言倒计时 ---- */

function startFunTick() {
  if (funTickTimer) {
    clearInterval(funTickTimer);
    funTickTimer = null;
  }
  const room = state?.room || {};
  const needFun = roomJoined && room.type === 'fun' && room.funEndsAt;
  const needMute = !!muteSelf;
  if (!needFun && !needMute) return;
  const tick = () => {
    if (needFun && $('#fun-left')) {
      const left = Math.max(0, room.funEndsAt - Date.now());
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      $('#fun-left').textContent = `⏳ 剩余 ${m}:${String(s).padStart(2, '0')}`;
      if (left <= 0) $('#fun-left').textContent = '⏳ 时间到';
    }
    if (muteSelf && Date.now() >= muteSelf.until) {
      muteSelf = null;
      renderStudy();
      toast('已解除禁言', '注意发言频率和内容');
      return;
    }
    if (muteSelf && $('#mute-left')) {
      const left = Math.max(0, Math.ceil((muteSelf.until - Date.now()) / 1000));
      $('#mute-left').textContent = `${Math.floor(left / 60)} 分 ${left % 60} 秒`;
    }
  };
  tick();
  funTickTimer = setInterval(tick, 1000);
}

/* ---- 拉人：发现同 WiFi 的同学并邀请 ---- */

async function openInviteDialog() {
  const peers = await api.roomPeers();
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="width:440px">
      <h2>📨 拉人进房间</h2>
      <p class="modal-sub">同一 WiFi 下开着本应用的同学会自动出现，点一下就能邀请。也可以把阿刺（虚拟战友）拉进来陪你。</p>
      <div class="peer-list" id="peer-list">
        <div class="peer-row" style="background:rgba(23,205,168,0.08)">
          <span class="peer-av">🌵</span>
          <div class="peer-main">
            <div class="peer-name">阿刺（我的战友）</div>
            <div class="peer-meta">虚拟成员 · 陪聊 / PK / 战术建议</div>
          </div>
          <button class="btn small" data-companion="1">拉进来</button>
        </div>
        ${
          peers.length
            ? peers
                .map(
                  (p) => `<div class="peer-row">
              <span class="peer-av">${esc(p.avatar || '🙂')}</span>
              <div class="peer-main">
                <div class="peer-name">${esc(p.name)}</div>
                <div class="peer-meta">${p.room ? `在${p.room.type === 'fun' ? '娱乐房' : '自习房'} · ${esc(p.room.code)}` : '未在房间'} · ${esc(p.ip)}</div>
              </div>
              <button class="btn small" data-inv="${esc(p.ip)}" data-port="${p.port}">邀请</button>
            </div>`
                )
                .join('')
            : '<div class="peer-empty">暂时没发现同学<br/>请确认对方也打开了应用、连着同一个 WiFi</div>'
        }
      </div>
      <div class="form-foot"><button class="btn ghost" data-close="1">关闭</button></div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', async (e) => {
    const t = e.target;
    if (t === mask || t.dataset.close) return mask.remove();
    if (t.dataset.companion) {
      const r = await api.roomCompanion(true);
      if (r && r.ok) { toast('阿刺进房了 🌵', r.message); t.textContent = '已进房'; t.disabled = true; }
      else toast((r && r.message) || '拉入失败', '', true);
      return;
    }
    if (t.dataset.inv) {
      const r = await api.roomInvite({ ip: t.dataset.inv, port: Number(t.dataset.port) });
      if (r.ok) {
        t.textContent = '已邀请';
        t.disabled = true;
      } else toast(r.message || '邀请失败', '', true);
    }
  });
}

function renderMembers() {
  const grid = $('#member-grid');
  if (!grid) return;
  const myState = {
    status: pomo.phase === 'focus' ? 'studying' : pomo.phase === 'break' ? 'rest' : 'idle',
    focus: (state.todayFocus || 0) + (pomo.phase === 'focus' ? Math.round((pomo.total - pomo.left) / 60) : 0),
    bpm: hrOn && hr ? hr.bpm : 0,
    cam: !!hrOn,
    scr: !!scrOn,
    hrq: hrOn && hr ? Math.round((hr.quality || 0) * 100) : 0,
  };
  // 房间模式下用服务器快照；自己那一项始终用本地实时数据
  // 房主刚建好房、还没有成员连入时，也要显示自己的卡片
  const items = roomJoined
    ? (roomMembers.length
        ? roomMembers.map((m) => (m.self ? { ...m, st: myState, name: (state.profile.name || '我') + '（我）' } : m))
        : [{ self: true, name: (state.profile.name || '我') + '（我）', avatar: state.profile.avatar || '🙂' }])
    : [];

  if (!roomJoined) {
    grid.innerHTML = '';
    return;
  }

  grid.innerHTML = items
    .map((m) => {
      const st = m.st || {};
      const statusMap = { studying: ['专注中', 'on'], rest: ['休息中', 'rest'], idle: ['在场', ''] };
      const [label, cls] = statusMap[st.status] || statusMap.idle;
      return `
      <div class="member-card">
        <span class="mc-avatar">${esc(m.avatar || '🙂')}</span>
        <div class="mc-main">
          <div class="mc-name">${esc(m.name || '同学')}</div>
          <div class="mc-meta">
            <span class="mc-dot ${cls}"></span>${label} · 专注 ${st.focus || 0} 分钟
            ${st.cam
              ? ` · 📷 ❤️ ${st.bpm || '--'} BPM · 信号 ${st.hrq || 0}%`
              : ' · 📷 未开'}
            ${st.scr ? ' · 🖥 共享屏幕' : ''}
          </div>
        </div>
      </div>`;
    })
    .join('');
}

/* ---- 房间事件 ---- */

function bindRoomEvents() {
  api.onRoom((evt) => {
    // LiveKit 语音：门票自动连麦；退出房间自动断开
    if (evt.type === 'livekit') {
      if (window.PQVoice) PQVoice.connect({ url: evt.url, token: evt.token });
      return;
    }
    // 局域网语音信令（点对点，不依赖 LiveKit）
    if (evt.type === 'rtc') {
      lanVoiceSignal(evt.from, evt.data);
      return;
    }
    if (evt.type === 'closed' && window.PQVoice) PQVoice.disconnect();
    if (evt.type === 'closed') lanVoiceStop(true);
    if (evt.type === 'snapshot') {
      roomMembers = (evt.members || []).map((m, i) => ({ ...m, self: false }));
      // 优先用协议给的 id 认领"我"，认不到再退回同名匹配
      const meId = evt.yourId || (state && state.room && state.room.myId);
      const mineById = meId ? roomMembers.find((m) => m.id === meId) : null;
      if (mineById) mineById.self = true;
      if (state && state.profile) {
        const mine = roomMembers.find((m) => m.name === (state.profile.name || '我') && m.avatar === (state.profile.avatar || '🙂'));
        if (mine) mine.self = true;
        if (!roomMembers.some((m) => m.self)) roomMembers.unshift({ name: state.profile.name || '我', avatar: state.profile.avatar || '🙂', st: {}, self: true });
      }
      renderMembers();
      renderCamStrip();
      renderScrStrip();
      syncLanVoicePeers();
    } else if (evt.type === 'reaction') {
      if (evt.emoji === '👋') toast(`${evt.emoji} ${evt.from}${evt.text || ''}`);
      else if (evt.emoji === '🚪') {
        // 有人退出：把他的摄像头画面清掉
        const gone = roomMembers.find((m) => m.name === evt.from);
        if (gone) {
          camFrames.delete(gone.id);
          scrFrames.delete(gone.id);
        }
        toast(`${evt.from} 离开了自习房`);
      } else if (evt.emoji) toast(`${evt.emoji} ${evt.from || ''} 给大家加油`);
    } else if (evt.type === 'camFrame') {
      if (!roomJoined) return;
      const myId = state?.room?.myId;
      if (!evt.from || evt.from === myId) return; // 不显示自己的回传帧
      camFrames.set(evt.from, { url: evt.d, at: Date.now() });
      updateCamFrames();
    } else if (evt.type === 'shareFrame') {
      if (!roomJoined) return;
      const myId = state?.room?.myId;
      if (!evt.from || evt.from === myId) return;
      scrFrames.set(evt.from, { url: evt.d, at: Date.now() });
      if (!$('#scr-strip')?.innerHTML) renderScrStrip();
      updateScrFrames();
    } else if (evt.type === 'chat') {
      pushChat(evt.msg);
    } else if (evt.type === 'mute') {
      // 自己被禁言 → 显示横幅并禁用输入
      const me = state?.room?.myId;
      const isMe = evt.id === me || (evt.name && evt.name === (state?.profile?.name || '我') && !evt.id?.startsWith?.('m-'));
      if (isMe) {
        muteSelf = { until: Date.now() + Number(evt.seconds || 60) * 1000, reason: evt.reason };
        alaScold('mute', evt.reason || '违反房间发言规则');
        if (currentView === 'study') renderStudy();
      }
    } else if (evt.type === 'unmute') {
      const me = state?.room?.myId;
      if (evt.id === me) {
        muteSelf = null;
        if (currentView === 'study') renderStudy();
      }
    } else if (evt.type === 'chatDenied') {
      if (evt.left) muteSelf = { until: Date.now() + Number(evt.left) * 1000, reason: evt.reason };
      toast('🔇 你被禁言了', evt.reason || '违反房间发言规则', true);
      alaScold('mute', evt.reason || '违反房间发言规则');
      if (currentView === 'study') renderStudy();
    } else if (evt.type === 'funEnded') {
      roomJoined = false;
      roomMembers = [];
      chatLog = [];
      muteSelf = null;
      resetAiChat();
      camStop(true);
      camFrames.clear();
      scrStop(true);
      scrFrames.clear();
      if (funTickTimer) clearInterval(funTickTimer);
      if (currentView === 'study') renderStudy();
      toast('⏰ 娱乐房时间到', evt.reason || '兑换时长已用完', true);
    } else if (evt.type === 'invite') {
      showInvite(evt);
    } else if (evt.type === 'closed') {
      roomJoined = false;
      roomMembers = [];
      camStop(true);
      camFrames.clear();
      scrStop(true);
      scrFrames.clear();
      if (currentView === 'study') renderStudy();
      toast('已退出 / 房间已关闭', '', evt.left ? false : true);
    }
  });
}

/* ---- 房间状态同步 ---- */

let roomSyncTimer = null;
function syncRoomState() {
  if (!roomJoined) return;
  const focusNow = (state?.todayFocus || 0) + (pomo.phase === 'focus' ? Math.round((pomo.total - pomo.left) / 60) : 0);
  api.roomState({
    status: pomo.phase === 'focus' ? 'studying' : pomo.phase === 'break' ? 'rest' : 'idle',
    focus: focusNow,
    bpm: hrOn && hr ? hr.bpm : 0,
    cam: !!(hrOn || camOn),
    scr: !!scrOn,
    hrq: hrOn && hr ? Math.round((hr.quality || 0) * 100) : 0,
  });
}
setInterval(syncRoomState, 5000);

/* 首次开启强制模式前的说明卡：只讲清「能做什么」和「怎么退出」，不做情感绑架 */
function showForceIntro() {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="max-width:470px">
        <h3>🛡️ 开启强制模式，你会多出这些能力</h3>
        <div class="force-intro">
          <div class="fi-row"><b>负分缓冲区</b><span>欠分不再一刀切封禁：-10 分内低价奖励还能换（双倍价），-30 分内靠救赎券，-30 分以下才全锁。</span></div>
          <div class="fi-row"><b>微目标回升</b><span>欠分后只给你「今天打开软件」这种极小步骤，每完成一条负分立刻 -5。</span></div>
          <div class="fi-row"><b>积分借贷</b><span>急用时可以借分，代价是 7 天效率折扣 + 3 天全勤，按时还清信用更好。</span></div>
          <div class="fi-row"><b>开机自愈</b><span>开机自动拉起守护，不怕手动关掉就一定失效。</span></div>
        </div>
        <div class="cp-hint" style="margin-top:10px">
          不开强制模式，上面这些一项都用不到；开了也不会强迫你使用它们——<b>每一档惩罚都写明了怎么解除</b>。
          随时可以用守护密码关闭，关闭本身不扣分、不弹劝说。
        </div>
        <div class="modal-btns">
          <button class="btn ghost" id="fi-no">先不开</button>
          <button class="btn" id="fi-yes">开启</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const done = (v) => { mask.remove(); resolve(v); };
    $('#fi-no', mask).onclick = () => done(false);
    $('#fi-yes', mask).onclick = () => done(true);
  });
}

/* ================= 视图：守护（强制模式） ================= */

let guardInfo = null;

async function askPassword(title = '需要验证守护密码') {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="width:360px">
        <h2>🔒 ${esc(title)}</h2>
        <input class="input" type="password" id="pw-input" placeholder="输入守护密码"/>
        <div class="form-foot">
          <button class="btn ghost" data-r="0">取消</button>
          <button class="btn" data-r="1">验证</button>
        </div>
      </div>`;
    const done = (v) => {
      mask.remove();
      resolve(v);
    };
    mask.addEventListener('click', (e) => {
      const r = e.target.closest('[data-r]')?.dataset.r;
      if (r === '1') done($('#pw-input', mask).value);
      else if (r === '0' || e.target === mask) done(null);
    });
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done($('#pw-input', mask).value);
      if (e.key === 'Escape') done(null);
    });
    $('#modal-root').appendChild(mask);
    $('#pw-input', mask).focus();
  });
}

async function renderGuard() {
  guardInfo = await api.guardInfo();
  const g = guardInfo;

  const listCard = (key, title, icon, desc) => `
    <div class="panel list-panel">
      <div class="section-head" style="margin-bottom:8px">
        <h3 style="margin:0">${icon} ${title}</h3>
      </div>
      <p class="list-desc">${desc}</p>
      <div class="list-chips" id="chips-${key}">
        ${g[key].length ? g[key].map((n) => `<span class="pc-chip">${esc(n)}<button data-del="${key}|${esc(n)}">✕</button></span>`).join('') : '<span class="mit-empty">暂无</span>'}
      </div>
      <div class="list-addrow" data-key="${key}">
        <select class="select proc-select" style="flex:1"><option value="">从运行中的进程选择…</option></select>
        <input class="input manual-input" placeholder="或手动输入进程名" style="width:150px"/>
        <button class="btn small" data-add="${key}">添加</button>
      </div>
    </div>`;

  $('#view').innerHTML = `
    <div class="view-head">
      <div class="view-title">守护 · 强制模式</div>
      <div class="view-sub">名单管理需要密码 · 违规应用会被强制关闭</div>
    </div>

    ${
      g.hasPassword
        ? ''
        : `
      <div class="panel">
        <h3>① 创建守护账户</h3>
        <p class="list-desc">设置后，修改名单、开关强制模式、更改计划都需要输入密码。密码只在本机保存哈希，绝不上传明文。</p>
        <div style="display:flex;gap:10px;max-width:520px">
          <input class="input" id="g-user" placeholder="账户名" style="flex:1"/>
          <input class="input" id="g-pass" type="password" placeholder="密码（至少4位）" style="flex:1"/>
          <button class="btn" id="g-setup">创建</button>
        </div>
      </div>`
    }

    <div class="panel">
      <div class="set-row" style="border:0;padding-top:0">
        <div class="set-info">
          <div class="st">强制模式 ${g.enabled ? '<span style="color:var(--danger);font-size:12px">（运行中）</span>' : ''}</div>
          <div class="sd">
            开启后：<b>黑名单</b>应用随时强制关闭；没有计划进行中时，<b>灰名单</b>也会被关闭；
            弹窗提醒 60 秒不处理记 1 次忽略，累计 5 次扣 15 积分。
          </div>
          <div class="sd" style="margin-top:6px">
            📋 <b>名单外软件</b>（三张名单都没有、且正在使用）会弹窗提醒，同一软件满 5 次扣 15 积分；
            提醒窗口里可以直接「全部关闭」。
          </div>
          ${
            g.isAdmin
              ? '<div class="admin-ok">✅ 当前以管理员权限运行，强制关闭对任何软件都有效</div>'
              : `<div class="admin-warn">⚠️ 当前是普通权限：以管理员运行的软件无法被关闭${g.enabled ? '，应用将自动提权重启' : ''}</div>
                 <button class="btn small warm" id="g-admin">以管理员身份重启</button>`
          }
        </div>
        <div class="switch ${g.enabled ? 'on' : ''}" id="g-switch"></div>
      </div>
    </div>

    <div class="force-stat">
      🗓️ 本月强制模式开启 <b>${(state.force && state.force.monthDays) || 0}/${(state.force && state.force.monthTotal) || 30}</b> 天
      · 连续 <b>${(state.force && state.force.streak) || 0}</b> 天
      <span style="color:var(--dim)">（关掉不扣分、不弹劝说，这里只记你开了多少天）</span>
    </div>

    ${
      g.escalated
        ? `<div class="panel" style="border-color:var(--danger)">
        <h3 style="color:var(--danger);margin-top:0">⛔ 积分为负 · 名单已升级</h3>
        <p class="list-desc" style="margin-bottom:0">
          当前积分 <b>${g.points}</b>：<b>灰名单按黑名单处理</b>（强制模式期间随时关闭）；
          <b>普通软件按灰名单处理</b>（没有计划进行中时关闭）；
          <b>计划放行的普通进程已全部禁用</b>（转正后自动恢复）。积分回到正数后自动恢复原状。
        </p>
      </div>
      <div class="panel">
        <h3>⏳ 灰名单兑换时长（负分期间可用）</h3>
        <p class="list-desc">把灰名单软件兑换成一条<b>临时计划</b>：从现在起 N 分钟内只放行该软件，时段结束自动失效，<b>第二天自动删除</b>。每个软件每天最多兑换 <b>30 分钟</b>；价格与娱乐房一致（每 10 分钟 15 积分），负分状态下照常扣分——兑换越多，走出负分越慢。</p>
        ${
          g.graylist.length
            ? g.graylist
                .map((n) => {
                  const key = String(n).toLowerCase().replace(/\.exe$/, '');
                  const used = (state.grayRedeem?.used || {})[key] || 0;
                  const left = Math.max(0, (state.grayRedeem?.limit || 30) - used);
                  const btns = [5, 10, 15, 30]
                    .filter((m) => m <= left)
                    .map((m) => `<button class="btn small" data-redeem="${esc(n)}|${m}">${m} 分钟（${Math.ceil(m / 10) * (state.grayRedeem?.costPer10 || 15)} 分）</button>`)
                    .join(' ');
                  return `<div class="set-row"><div class="set-info"><div class="st">⚠️ ${esc(n)}</div><div class="sd">今日已兑换 ${used} 分钟 · 今日还剩 ${left} 分钟</div></div><div style="display:flex;gap:6px;flex-wrap:wrap">${btns || '<span class="mit-empty">今日已兑换满 30 分钟</span>'}</div></div>`;
                })
                .join('')
            : '<p class="list-desc">灰名单是空的，先在下面把软件加入灰名单。</p>'
        }
      </div>`
        : ''
    }

    <div class="guard-grid">
      ${listCard('whitelist', '白名单', '✅', '随时可用，任何模式下都不会被关闭。')}
      ${listCard('graylist', '灰名单', '⚠️', '没有计划进行中的时段会被强制关闭，计划开始后自动放行。')}
      ${listCard('blacklist', '黑名单', '⛔', '强制模式开启期间始终强制关闭。')}
    </div>

    <div class="panel">
      <h3>惩罚规则</h3>
      <div class="set-row"><div class="set-info"><div class="st">弹窗提醒忽略</div><div class="sd">60 秒内不打卡 / 不点稍后 / 不跳过，记 1 次；每累计 ${g.strikeLimit} 次扣 ${g.strikeDeduct} 积分。</div></div></div>
      <div class="set-row"><div class="set-info"><div class="st">名单外普通软件</div><div class="sd">只弹提醒，<b>不扣积分</b>。常用就加白名单；只是某个计划要用，就写进那个计划的「计划内需要的软件」。</div></div></div>
      <div class="set-row"><div class="set-info"><div class="st">唯一会扣积分的计划操作</div><div class="sd">计划里<b>新放行非白名单普通软件</b>扣 10 积分（修改标题 / 时间 / 星期、只放行白名单软件、暂停、重新启用、删除，全部不扣分）。</div></div></div>
      <div class="set-row"><div class="set-info"><div class="st">计划内需要的软件</div><div class="sd">计划里可以指定放行的进程，计划时段内可用；同一进程累计不超过 1 小时，用满后按普通软件处理。不能与黑/灰名单重叠。</div></div></div>
      <div class="set-row"><div class="set-info"><div class="st">积分为负 → 名单升级</div><div class="sd">强制模式下，积分变成负数时灰名单升级为黑名单、普通非白名单软件升级为灰名单、计划放行的普通进程全部禁用；积分转正后自动恢复。负分期间可在上方把灰名单软件兑换成临时计划（每项每天最多 30 分钟，第二天删除）。</div></div></div>
      <div class="set-row"><div class="set-info"><div class="st">计划放行额度</div><div class="sd">${
        Object.entries((g.planUsage && g.planUsage.remain) || {})
          .map(([k, v]) => `${esc(k)} 剩余 ${v} 分钟`)
          .join(' · ') || '当前没有正在使用的计划放行软件（每个进程上限 60 分钟）'
      }</div></div></div>
      <div class="set-row"><div class="set-info"><div class="st">当前忽略计数</div><div class="sd">${Object.entries(g.strikes || {}).map(([k, v]) => `${esc(planName(k))}：${v} 次`).join(' · ') || '暂无忽略记录'}</div></div></div>
    </div>
  `;

  bindGuard();
}

function planName(id) {
  const p = (state.plans || []).find((x) => x.id === id);
  return p ? p.title : '已删除的计划';
}

async function guardEditLists(fn) {
  const pw = guardInfo.hasPassword ? await askPassword('修改名单需要验证') : null;
  if (guardInfo.hasPassword && pw === null) return;
  const res = await api.guardSetLists({ lists: fn(guardInfo), password: pw });
  if (res.ok) {
    toast('名单已更新');
    renderGuard();
  } else if (res.needPassword) {
    toast('密码不对', '', true);
  } else {
    toast(res.message || '修改失败', '', true);
  }
}

function bindGuard() {
  const g = guardInfo;

  $('#g-setup') &&
    ($('#g-setup').onclick = async () => {
      const user = $('#g-user').value.trim();
      const pass = $('#g-pass').value;
      const res = await api.guardSetup({ user, password: pass });
      if (res.ok) {
        toast('守护账户已创建', '以后改名单、改计划都要密码了');
        renderGuard();
      } else {
        toast(res.message || '创建失败', '', true);
      }
    });

  $('#g-switch') &&
    ($('#g-switch').onclick = async () => {
      const target = !guardInfo.enabled;
      // 首次开启：先把「专属能力」和「解除路径」讲清楚，再让用户决定
      if (target && !(state.force && state.force.everUsed)) {
        const go = await showForceIntro();
        if (!go) return;
      }
      const pw = guardInfo.hasPassword ? await askPassword(target ? '开启强制模式' : '关闭强制模式') : null;
      if (guardInfo.hasPassword && pw === null) return;
      const res = await api.guardToggle({ enabled: target, password: pw });
      if (res.ok) {
        if (res.elevating) {
          toast('🛡️ 强制模式已开启 · 正在申请管理员权限', '应用会自动重启，请在 UAC 弹窗点「是」');
          return;
        }
        toast(target ? '🛡️ 强制模式已开启' : '强制模式已关闭', target ? '黑名单应用将被强制关闭' : '');
        renderGuard();
      } else if (res.needPassword) {
        toast('密码不对', '', true);
      }
    });

  $('#g-admin') &&
    ($('#g-admin').onclick = async () => {
      const r = await api.guardAdminRestart();
      if (r && r.alreadyAdmin) toast('已经是管理员权限了');
      else toast('正在以管理员身份重启…', r && r.silent ? '通过计划任务静默提权' : '请在 UAC 弹窗点「是」');
    });

  // 灰名单兑换时长（负分期间）
  $$('[data-redeem]').forEach((btn) => {
    btn.onclick = async () => {
      const [name, min] = btn.dataset.redeem.split('|');
      const minutes = Number(min);
      const cost = Math.ceil(minutes / 10) * (state.grayRedeem?.costPer10 || 15);
      const ok = await confirmDialog(
        `给「${name}」兑换 ${minutes} 分钟？`,
        `将扣除 ${cost} 积分（负分时会扣得更深），生成一条临时计划：${minutes} 分钟内只放行该软件，明天自动删除。`
      );
      if (!ok) return;
      const res = await api.guardRedeemGray({ name, minutes });
      if (res.ok) {
        toast('⏳ 兑换成功', res.message);
        renderGuard();
      } else {
        toast(res.message || '兑换失败', '', true);
      }
    };
  });

  // 进程下拉
  $$('.proc-select').forEach(async (sel) => {
    const procs = await api.guardProcesses();
    sel.innerHTML =
      '<option value="">从运行中的进程选择…</option>' +
      procs
        .slice(0, 400)
        .map((p) => `<option value="${esc(p.name)}">${esc(p.name)} (${p.pids})</option>`)
        .join('');
  });

  $$('[data-add]').forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.add;
      const row = btn.closest('.list-addrow');
      const val = (row.querySelector('.proc-select').value || row.querySelector('.manual-input').value || '').trim();
      if (!val) return toast('先选一个进程或输入名称', '', true);
      if (guardInfo[key].some((x) => x.toLowerCase() === val.toLowerCase())) return toast('已经在名单里了');
      guardEditLists((lists) => ({ ...lists, [key]: [...lists[key], val.replace(/\.exe$/i, '')] }));
    };
  });

  $$('[data-del]').forEach((btn) => {
    btn.onclick = () => {
      const [key, name] = btn.dataset.del.split('|');
      guardEditLists((lists) => ({ ...lists, [key]: lists[key].filter((x) => x !== name) }));
    };
  });
}

/* ================= 视图：成就 ================= */

/* 信誉分统一取值：别在十几个地方各算一遍默认值 */
function creditScore() {
  const n = Number(state && state.credit && state.credit.score);
  return Number.isFinite(n) ? n : 100;
}

/* 三档特权（L1 基础 / L2 社交 / L3 荣耀）
 * 只列真的会拦、真的会给的；没做到的标「规划中」，不写成已解锁。 */
function creditLevelHTML() {
  const P = window.PQCreditPriv;
  if (!P) return '';
  const score = creditScore();
  const cur = P.levelOf(score);
  const list = P.privs(score);
  const lvs = P.LEVELS.map((lv) => {
    const mine = list.filter((p) => p.lv === lv.key);
    const open = P.atLeast(score, lv.key);
    return `<div class="rp-lv ${open ? 'on' : ''}">
      <div class="rp-lv-t">
        <b>${lv.key} ${lv.name}</b>
        <span class="rp-lv-min">≥ ${lv.min} 分</span>
        ${
          open
            ? '<span class="rp-chip on">已具备</span>'
            : `<span class="rp-chip">还差 ${Math.max(0, lv.min - score)} 分</span>`
        }
      </div>
      <div class="rp-lv-d">${esc(lv.title)} · ${esc(lv.desc)}</div>
      <ul class="rp-ps">
        ${mine
          .map(
            (p) => `<li class="${p.unlocked ? '' : 'off'}">
              <b>${esc(p.name)}</b>${p.coming ? '<span class="rp-tag">规划中</span>' : ''}
              <span class="rp-d">${esc(p.good)}</span>
            </li>`
          )
          .join('')}
      </ul>
    </div>`;
  }).join('');
  return `<div class="rp-block">
    <div class="rp-head">
      信誉等级 <b>${cur.key || '—'} ${esc(cur.name)}</b>
      <span class="rp-sub">${cur.key ? esc(cur.title) : '先把分修回来'}</span>
      ${cur.next ? `<span class="rp-next">再 ${cur.nextIn} 分到 ${cur.next.key} ${esc(cur.next.name)}</span>` : '<span class="rp-next">已到最高档</span>'}
    </div>
    <div class="rp-lvs">${lvs}</div>
    <div class="rp-foot">等级只决定「能做什么」，不决定「你是谁」。分数不能买，只能靠打卡、守约、帮人一点点攒。</div>
  </div>`;
}

/* 信誉分卡片（成就页与商城共用一份口径） */
function repPanelHTML() {
  const cr = (state && state.credit) || {};
  const rep = cr.rep || {};
  const pil = cr.pillars || { honest: 0, ally: 0, growth: 0 };
  const led = cr.ledger || [];
  const sc = Number(cr.score == null ? 100 : cr.score);
  const tierName = sc >= 120 ? '可信' : sc >= 100 ? '良好' : sc >= 80 ? '普通' : '受限';
  const cnt = (o, a, b) => `${(o && o[a]) || 0} / ${(o && o[b]) || 0}`;
  const card = (title, main, sub) => `
    <div class="rep-card" style="padding:8px 10px;border:1px solid var(--line);border-radius:10px">
      <div style="font-size:11px;color:var(--text-3)">${title}</div>
      <div><b>${main}</b> <span class="chat-tip">${sub}</span></div>
    </div>`;
  return `
    <div class="panel">
      <h3>🛡 信誉分 <span class="tag">${sc} · ${tierName}</span></h3>
      <div class="sd" style="margin:2px 0 10px">
        与借分共用一套分（0~160）。三支柱（近 30 天）：
        <b>诚实度 ${pil.honest > 0 ? '+' : ''}${pil.honest}</b> ·
        <b>联盟贡献 ${pil.ally > 0 ? '+' : ''}${pil.ally}</b> ·
        <b>成长 ${pil.growth > 0 ? '+' : ''}${pil.growth}</b>
        ${cr.jailed ? ' · ⛓ <b>失信期</b>' : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
        ${card('翻案准确率', cnt(rep.flips, 'ok', 'bad'), '核实 / 被推翻')}
        ${card('举报有效度', cnt(rep.reports, 'ok', 'bad'), '属实 / 恶意')}
        ${card('贷款守约', cnt(rep.loans, 'ok', 'bad'), '守约 / 逾期')}
        ${card('助人被确认', (rep.help && rep.help.ok) || 0, '次')}
        ${card('联机稳定', (rep.online && rep.online.ok) || 0, `次 · 挂机 ${(rep.online && rep.online.bad) || 0}`)}
        ${card('成长加分', (rep.growth && rep.growth.ok) || 0, '次全勤/纪录')}
      </div>
      ${
        led.length
          ? `<div class="sd" style="margin-top:10px;line-height:1.9;max-height:120px;overflow:auto;border-top:1px dashed var(--line);padding-top:8px">
              最近账本：${led
                .slice(0, 8)
                .map((e) => `${new Date(e.at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} <b style="color:${e.delta > 0 ? '#2a8f53' : '#d43b40'}">${e.delta > 0 ? '+' : ''}${e.delta}</b> ${esc(String(e.note || '').slice(0, 18))}`)
                .join('<br/>')}
             </div>`
          : '<div class="sd" style="margin-top:8px">还没有信誉记录 —— 打卡全勤、翻案复核、守约还分都会记在这里。</div>'
      }
      ${creditLevelHTML()}
    </div>`;
}

function renderStats() {
  const p = state.profile;
  const maxDue = Math.max(1, ...state.week.map((w) => w.due));

  $('#view').innerHTML = `
    <div class="view-head">
      <div class="view-title">成就</div>
      <div class="view-sub">坚持就是最好的奖励</div>
    </div>

    <div class="tiles">
      <div class="tile"><div class="v">${p.points}</div><div class="t">总积分</div></div>
      <div class="tile"><div class="v" style="color:var(--amber)">🔥 ${p.streak}</div><div class="t">当前连续（天）</div></div>
      <div class="tile"><div class="v">${p.bestStreak || 0}</div><div class="t">最长连续（天）</div></div>
      <div class="tile"><div class="v">${p.totalDone}</div><div class="t">累计打卡（次）</div></div>
      <div class="tile"><div class="v">🍅 ${state.todayPomodoro}</div><div class="t">今日番茄</div></div>
      <div class="tile"><div class="v">${state.todayFocus}</div><div class="t">今日专注（分钟）</div></div>
      <div class="tile"><div class="v">${p.focusMinutes || 0}</div><div class="t">累计专注（分钟）</div></div>
    </div>

    ${repPanelHTML()}

    <div class="panel">
      <h3>等级</h3>
      <div class="lv-line">
        <span class="now">Lv.${p.level}</span>
        <span class="next">距离 Lv.${p.level + 1} 还需 ${p.levelNeed - p.levelCur} 积分</span>
      </div>
      <div class="bar" style="height:10px"><div class="bar-fill" style="width:${Math.min(100, (p.levelCur / p.levelNeed) * 100)}%"></div></div>
    </div>

    <div class="panel">
      <h3>近 7 天打卡</h3>
      <div class="week-chart">
        ${state.week
          .map((w) => {
            const h = Math.max(6, (w.done / maxDue) * 100);
            return `
            <div class="wc-col ${w.isToday ? 'today' : ''}">
              <span class="wc-num">${w.done}${w.due ? '/' + w.due : ''}</span>
              <div class="wc-bar" style="height:${Math.max(14, h)}%">
                <div class="fill" style="height:${w.due ? (w.done / w.due) * 100 : 0}%"></div>
              </div>
              <span class="wc-label">${w.isToday ? '今天' : '周' + w.label}</span>
            </div>`;
          })
          .join('')}
      </div>
    </div>

    <div class="panel">
      <h3>本月打卡日历</h3>
      <div class="heatmap" id="month-heatmap"></div>
      <div class="hm-legend">完成度：<i style="background:#ff8a80"></i>0% <i style="background:#a5e8a5"></i>低 <i style="background:#5fce6b"></i>中 <i style="background:#1f9d3d"></i>高（全绿=全勤）</div>
      <div class="row-btns">
        <button class="btn small ghost" id="print-calendar">🖨️ 打印/截图本月日历图</button>
        <button class="btn small ghost" id="export-csv">📊 导出 Excel 明细</button>
      </div>
    </div>

    <div class="panel">
      <h3>近 30 天打卡率</h3>
      <canvas id="trend-chart" height="150" style="width:100%"></canvas>
    </div>

    <div class="panel">
      <h3>每周复盘 · 本周打卡率 ${weeklyRate()}%</h3>
      <div class="sd" style="margin-bottom:8px">勾选或写下下周要改进的事：</div>
      <div class="review-items">${(currentReview().items || []).map((it, i) => `
        <div class="mit-item done"><span class="mit-check">✓</span><span class="mit-text">${esc(it)}</span><button class="icon-btn del" data-rvdel="${i}">✕</button></div>`).join('') || '<div class="mit-empty">还没有改进项</div>'}</div>
      <div class="mit-addrow">
        <input class="input" id="rv-input" maxlength="40" placeholder="如：睡前 15 分钟不刷手机"/>
        <button class="btn" id="rv-add">＋ 添加</button>
      </div>
    </div>

    <div class="panel">
      <h3>徽章（${state.badges.filter((b) => b.unlocked).length}/${state.badges.length}）</h3>
      <div class="badge-grid">
        ${state.badges
          .map(
            (b) => `
          <div class="badge ${b.unlocked ? 'on' : ''}">
            <span class="ic">${b.icon}</span>
            <div><div class="nm">${esc(b.name)}</div><div class="ds">${esc(b.unlocked ? b.desc : '未解锁 · ' + b.desc)}</div></div>
          </div>`
          )
          .join('')}
      </div>
    </div>

    <div class="panel">
      <h3>分享</h3>
      <div class="sd" style="margin-bottom:10px">生成打卡海报或复制应用链接。海报内容<b>默认全部隐藏</b>，需要你在面板里逐项勾选才会显示。</div>
      <div class="row-btns">
        <button class="btn small" id="open-share">🖼️ 生成分享海报</button>
      </div>
    </div>
  `;

  renderHeatmap();
  drawTrendChart();
  const shareBtn = $('#open-share');
  if (shareBtn) shareBtn.onclick = openSharePanel;
  $('#print-calendar').onclick = () => api.exportCalendar();
  $('#export-csv').onclick = async () => {
    const r = await api.exportCsv();
    if (r.ok) toast('已导出 Excel 明细', r.path);
  };
  const rvAdd = $('#rv-add');
  rvAdd.onclick = async () => {
    const v = $('#rv-input').value.trim();
    if (!v) return;
    const items = [...currentReview().items, v];
    await api.reviewSetItems({ weekKey: isoWeekKey(new Date()), items });
    toast('已记入下周改进项');
  };
  $$('[data-rvdel]').forEach((btn) => {
    btn.onclick = () => {
      const items = [...currentReview().items];
      items.splice(Number(btn.dataset.rvdel), 1);
      api.reviewSetItems({ weekKey: isoWeekKey(new Date()), items });
    };
  });
}

/* 分享面板：把今日数据交给 PQShare，由面板里的勾选项决定画出哪些字段 */
function openSharePanel() {
  if (!window.PQShare) {
    toast('分享模块未加载', '', true);
    return;
  }
  const plans = (state.todayPlans || []).map((p) => ({ title: p.title, done: p.status === 'done' }));
  /* 只传「过程」数据。信誉分、等级、排名、可借额度这里一个都不给 ——
     海报那边也没有取它们的代码，privacy 不靠自觉，靠数据根本没到。 */
  const challengeDone = (state.contractProjects || []).filter((c) => c && c.expired && Number(c.progressPct) >= 100).length;
  window.PQShare.open({
    streak: state.profile.streak || 0,
    helpWeek: (state.credit && Number(state.credit.help7)) || 0,
    challengeDone: Math.max(0, challengeDone),
    focusMax: Number(state.focusMax) || 0,
    done: plans.filter((p) => p.done).length,
    total: plans.length,
    plans,
  });
}

function weeklyRate() {
  const ws = state.week.filter((w) => w.due > 0);
  if (!ws.length) return 0;
  return Math.round((ws.filter((w) => w.done >= w.due).length / ws.length) * 100);
}

function currentReview() {
  return state.reviews?.[isoWeekKey(new Date())] || { rate: 0, items: [] };
}

function isoWeekKey(dt) {
  const d = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function renderHeatmap() {
  const el = $('#month-heatmap');
  if (!el) return;
  const m = state.month;
  const cells = [];
  for (let i = 0; i < m.firstWeekday; i++) cells.push('<div class="hm-cell blank"></div>');
  for (const d of m.days) {
    const rate = d.due ? d.done / d.due : null;
    let cls = 'none';
    if (rate !== null) {
      if (rate === 0) cls = 'r0';
      else if (rate < 0.34) cls = 'r1';
      else if (rate < 0.67) cls = 'r2';
      else if (rate < 1) cls = 'r3';
      else cls = 'r4';
    }
    cells.push(
      `<div class="hm-cell ${cls} ${d.isToday ? 'today' : ''} ${d.future ? 'future' : ''}" title="${d.key}：${d.done}/${d.due}">${d.day}</div>`
    );
  }
  el.innerHTML = cells.join('');
}

function drawTrendChart() {
  const c = $('#trend-chart');
  if (!c) return;
  const ctx = c.getContext('2d');
  const W = (c.width = c.clientWidth * 2);
  const H = c.height;
  const data = state.trend30 || [];
  const pad = 24;
  ctx.clearRect(0, 0, W, H);

  // 网格线
  ctx.strokeStyle = 'rgba(128,128,128,0.15)';
  ctx.lineWidth = 1;
  for (const pct of [0, 50, 100]) {
    const y = pad + (H - pad * 2) * (1 - pct / 100);
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(W - pad, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(128,128,128,0.6)';
    ctx.font = '16px sans-serif';
    ctx.fillText(pct + '%', 2, y + 5);
  }

  const pts = data
    .map((d, i) => ({
      x: pad + ((W - pad * 2) * i) / Math.max(1, data.length - 1),
      y: pad + (H - pad * 2) * (1 - (d.rate ?? 0) / 100),
      rate: d.rate,
    }))
    .filter((p) => p.rate !== null);

  if (!pts.length) {
    ctx.fillStyle = 'rgba(128,128,128,0.6)';
    ctx.font = '18px sans-serif';
    ctx.fillText('暂无打卡数据', W / 2 - 60, H / 2);
    return;
  }

  // 折线
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#17cda8');
  grad.addColorStop(1, '#7c6cff');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 3;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();

  // 点
  for (const p of pts) {
    ctx.fillStyle = '#17cda8';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ================= 视图：目标 ================= */

function renderGoals() {
  const goals = state.goals || [];
  const cProjects = state.contractProjects || [];

  $('#view').innerHTML = `
    <div class="view-head">
      <div class="view-title">目标</div>
      <div class="view-sub">设定目标 · 拆解里程碑 · 见证进度</div>
    </div>

    <div class="row-btns" style="margin-bottom:14px">
      <button class="btn" id="goal-add">＋ 设定新目标</button>
    </div>

    ${
      goals.length
        ? goals.map((g) => renderGoalCard(g)).join('')
        : '<div class="empty"><div class="big">🎯</div><p>还没有目标。设定一个，如「3 个月减重 5 公斤」「一年读完 24 本书」。</p></div>'
    }

    <div class="section-head"><div class="section-title">📁 契约项目 · 子任务进「今日」金边打卡，未完成按天扣钱</div></div>
    <div class="row-btns" style="margin-bottom:12px">
      <button class="btn" id="cp-add">＋ 新建契约项目</button>
    </div>
    ${
      cProjects.length
        ? cProjects.map((c) => renderContractProjectCard(c)).join('')
        : '<div class="empty"><div class="big">🤝</div><p>还没有契约项目。建一个，给项目定时长和每日罚金，再往里加子任务——子任务会出现在「今日」里（金边），到期前项目和任务都删不掉。</p></div>'
    }
  `;

  $('#goal-add').onclick = openGoalForm;
  $('#cp-add').onclick = openContractProjectForm;
  bindGoalActions();
  bindContractProjectActions();
}

/* 契约热度图：近 35 天，格子颜色 = 当天契约完成度，红点 = 当天有应扣款 */
function heatGridHtml(heat) {
  if (!heat || !heat.days) return '';
  const cells = heat.days
    .map((d) => {
      let bg = 'var(--bg-3, rgba(127,127,127,.18))';
      if (d.pct !== null) {
        const a = 0.15 + 0.75 * (d.pct / 100);
        bg = `rgba(212,175,55,${a.toFixed(2)})`;
      }
      const owe = d.owe ? ` style="box-shadow:inset 0 0 0 2px var(--danger,#e5484d)"` : '';
      const tip = d.due
        ? `${d.key}${d.isToday && !d.future ? '（今日实时）' : ''}：完成 ${d.done}/${d.due}（${d.pct}%）${d.owe ? ` · 应扣 ¥${d.owe}` : ' · 不扣钱'}`
        : `${d.key}：无契约任务，不扣钱`;
      return `<div class="heat-cell" title="${tip}"${owe}><span style="background:${bg}"></span></div>`;
    })
    .join('');
  return `
    <div class="cp-heat">
      <div class="cp-heat-top">
        <div class="st">🔥 本项目近 35 天</div>
        <div class="cp-owe-total">累计应扣 <b style="color:var(--amber)">¥${heat.totalOwe}</b></div>
      </div>
      <div class="heat-grid">${cells}</div>
      <div class="sd" style="margin-top:8px">格子越黄完成度越高；带红边表示当天有应扣（今日那格是实时预估，补做完就归零）。悬停看明细。</div>
    </div>
  `;
}

function renderContractProjectCard(c) {
  const tasks = (state.plans || []).filter((p) => p.contract === c.id);
  const unpaid = Object.entries(c.settlements || {})
    .filter(([k, s]) => s && s.owe > 0 && !c.paid?.[k])
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const unpaidHtml = unpaid.length
    ? `<div class="rp-list">${unpaid
        .map(
          ([k, s]) => `
        <div class="rp-item"><span>💰 ${k} 完成度 ${s.pct}% · 应扣 <b style="color:var(--amber)">¥${s.owe}</b></span>
        <button class="btn small" data-cppaid="${c.id}|${k}">这笔已交</button></div>`
        )
        .join('')}</div>`
    : c.oweTotal
      ? `<div class="sd" style="margin-top:8px">✅ 应扣款都已标记已交，累计 ¥${c.oweTotal}</div>`
      : '';
  return `
    <div class="panel contract-card cp-card">
      <div class="goal-top">
        <div class="goal-info">
          <div class="goal-title">📁 ${esc(c.title)} ${c.expired ? '<span class="cp-tag">已到期</span>' : `<span class="cp-tag live">第 ${c.dayIndex}/${c.days} 天</span>`}</div>
          <div class="sd">${c.start} ~ ${c.endDate} · 每日罚金上限 ¥${c.stake} · 今日 ${c.todayDone}/${c.todayCount}${c.noTaskToday ? '（今日无任务，不扣钱）' : (c.todayOwe ? ` · 今日应扣 ¥${c.todayOwe}` : ' · 今日已全做完，不扣钱')} · 累计应扣 ¥${c.oweTotal}${c.oweUnpaid ? `（未交 ¥${c.oweUnpaid}）` : ''}</div>
          <div class="bar" style="height:8px;margin-top:8px"><div class="bar-fill" style="width:${c.progressPct}%"></div></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn small" data-cpadd="${c.id}">＋ 添加契约任务</button>
          ${
            c.expired
              ? `<button class="icon-btn del" data-cpdel="${c.id}" title="删除项目（含其全部子任务）">✕</button>`
              : '<span class="cp-tag" title="契约未到期，项目和任务都不能删除">🔒 到期前不可删除</span>'
          }
        </div>
      </div>
      ${unpaidHtml}
      ${heatGridHtml(c.heat)}
      <div class="ms-list">
        ${
          tasks.length
            ? tasks
                .map(
                  (p) => `
          <div class="mit-item ${p.enabled ? '' : 'off'}">
            <span class="mit-ico">${esc(p.icon)}</span>
            <span class="mit-text">${esc(p.title)} <span class="sd">· ${p.when === 'boot' ? '开机时' : p.time} · ${p.points} 分 · ${(p.days || []).map((d) => DAYS[d]).join('')}</span></span>
            <span class="cp-tag" title="契约任务创建后不可修改">🔒 不可改</span>
            ${c.expired ? `<button class="icon-btn del" data-cptdel="${p.id}" title="删除任务">✕</button>` : ''}
          </div>`
                )
                .join('')
            : '<div class="mit-empty">还没有子任务，点「＋ 添加契约任务」创建第一个</div>'
        }
      </div>
    </div>
  `;
}

function bindContractProjectActions() {
  $$('[data-cpadd]').forEach((btn) => {
    btn.onclick = () => {
      const c = (state.contractProjects || []).find((x) => x.id === btn.dataset.cpadd);
      if (c) openPlanForm(null, c.id);
    };
  });
  $$('[data-cpdel]').forEach((el) => {
    el.onclick = async () => {
      const ok = await confirmDialog('删除该契约项目？', '项目及其全部契约子任务、打卡与结算记录将一并删除（仅到期后可删）。');
      if (!ok) return;
      const r = await api.contractProjectDelete(el.dataset.cpdel);
      if (!r.ok) toast(r.message || '删除失败', '', true);
    };
  });
  $$('[data-cppaid]').forEach((btn) => {
    btn.onclick = async () => {
      const [id, date] = btn.dataset.cppaid.split('|');
      await api.contractProjectPay({ id, date });
      toast('💰 已标记为已交', '请确认转账已完成');
    };
  });
  $$('[data-cptdel]').forEach((el) => {
    el.onclick = async () => {
      const ok = await confirmDialog('删除该契约任务？', '仅项目到期后可删除。');
      if (!ok) return;
      const r = await api.deletePlan(el.dataset.cptdel);
      if (!r.ok) toast(r.message || '删除失败', '', true);
    };
  });
}

function openContractProjectForm() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="max-width:440px">
      <h3>📁 新建契约项目</h3>
      <div class="form-col">
        <input class="input" id="cp-title" maxlength="40" placeholder="项目名称，如：考研复习冲刺"/>
        <div class="form-row">
          <input class="input" id="cp-stake" type="number" min="1" max="9999" value="10" title="每天未全部完成时的应扣金额" style="flex:0 0 110px"/>
          <select class="select" id="cp-days">
            ${[7, 14, 21, 30, 60, 100, 180, 365].map((d) => `<option value="${d}" ${d === 30 ? 'selected' : ''}>时长 ${d} 天</option>`).join('')}
          </select>
        </div>
        <input class="input" id="cp-witness" maxlength="20" placeholder="见证人（可选）：写下他的名字，或留空"/>
        <div class="cp-hint">项目从今天开始，持续所选天数。子任务会出现在「今日」（金边），
        每天没全部完成就按完成度扣钱（最高 ¥<span id="cp-stake-v">10</span>/天），第二天在「今日」顶部显示昨日应扣。
        <b>项目与子任务到期前都不可删除</b>；创建任务不扣积分。
        <br/>📌 拆成每天能做完的一小步，比只写一个远大目标更容易坚持——这也是这里要求你先建子任务、再建项目的原因。
        <br/>👤 见证人只存在你自己的设备上，不会联网、不会通知对方；你可以把生成的那段话自己发给他。</div>
      </div>
      <div class="modal-btns">
        <button class="btn ghost" id="cp-cancel">取消</button>
        <button class="btn" id="cp-ok">创建项目</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  $('#cp-cancel', mask).onclick = () => mask.remove();
  $('#cp-stake', mask).oninput = (e) => ($('#cp-stake-v', mask).textContent = e.target.value || '10');
  $('#cp-ok', mask).onclick = async () => {
    const witnessName = $('#cp-witness', mask).value.trim();
    const r = await api.contractProjectAdd({
      title: $('#cp-title', mask).value.trim(),
      stake: Number($('#cp-stake', mask).value),
      days: Number($('#cp-days', mask).value),
    });
    if (!r.ok) return toast(r.message || '创建失败', '', true);
    // 见证人：只写本地记录，不联网、不推送
    if (witnessName && r.project && r.project.id) {
      await api.witnessSet({ projectId: r.project.id, name: witnessName });
    }
    mask.remove();
    toast('📁 契约项目已创建', '去项目卡片里添加子任务吧');
  };
  setTimeout(() => $('#cp-title', mask).focus(), 50);
}

function renderGoalCard(g) {
  const C = 2 * Math.PI * 40;
  const off = C * (1 - (g.percent || 0) / 100);
  return `
    <div class="panel goal-card">
      <div class="goal-top">
        <div class="ring-wrap small">
          <svg width="96" height="96">
            <circle class="ring-bg" cx="48" cy="48" r="40" fill="none" stroke-width="8"/>
            <circle class="ring-fill" cx="48" cy="48" r="40" fill="none" stroke-width="8"
              stroke-dasharray="${C}" stroke-dashoffset="${off}" style="stroke:var(--accent-2)"/>
          </svg>
          <div class="ring-center"><div class="ring-num">${g.percent}%</div><div class="ring-cap">${g.done}/${g.total}</div></div>
        </div>
        <div class="goal-info">
          <div class="goal-title">${esc(g.icon)} ${esc(g.title)}</div>
          <div class="sd">${g.deadline ? `截止：${esc(g.deadline)} · ` : ''}已完成 ${g.done} / ${g.total} 个里程碑</div>
          <div class="bar" style="height:8px;margin-top:8px"><div class="bar-fill" style="width:${g.percent}%"></div></div>
        </div>
        <button class="icon-btn del" data-goaldel="${g.id}" title="删除目标">✕</button>
      </div>
      <div class="ms-list">
        ${(g.milestones || [])
          .map(
            (m) => `
          <div class="mit-item ${m.done ? 'done' : ''}">
            <span class="mit-check" data-ms="${g.id}|${m.id}">${m.done ? '✓' : ''}</span>
            <span class="mit-text">${esc(m.title)}</span>
            <button class="icon-btn del" data-msdel="${g.id}|${m.id}">✕</button>
          </div>`
          )
          .join('') || '<div class="mit-empty">添加子目标，拆解成可执行的里程碑</div>'}
      </div>
      <div class="mit-addrow">
        <input class="input" data-msinput="${g.id}" maxlength="40" placeholder="添加每月/每周子目标，如：第一个月读 2 本"/>
        <button class="btn" data-msadd="${g.id}">＋ 添加</button>
      </div>
    </div>
  `;
}

function bindGoalActions() {
  $$('[data-ms]').forEach((el) => {
    el.onclick = () => {
      const [goalId, msId] = el.dataset.ms.split('|');
      api.goalToggleMilestone({ goalId, msId });
    };
  });
  $$('[data-msadd]').forEach((el) => {
    el.onclick = () => {
      const input = $(`[data-msinput="${el.dataset.msadd}"]`);
      const v = input.value.trim();
      if (v) api.goalAddMilestone({ goalId: el.dataset.msadd, title: v });
    };
  });
  $$('[data-msdel]').forEach((el) => {
    el.onclick = () => {
      const [goalId, msId] = el.dataset.msdel.split('|');
      api.goalDeleteMilestone({ goalId, msId });
    };
  });
  $$('[data-goaldel]').forEach((el) => {
    el.onclick = async () => {
      const ok = await confirmDialog('删除该目标？', '里程碑记录将一并删除，不可恢复。');
      if (ok) api.goalDelete(el.dataset.goaldel);
    };
  });
}

function openGoalForm() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="max-width:440px">
      <h3>🎯 设定新目标</h3>
      <div class="form-col">
        <input class="input" id="g-title" maxlength="40" placeholder="目标，如：一年读完 24 本书"/>
        <div class="form-row">
          <select class="select" id="g-icon">${['🎯', '💪', '📚', '🏃', '💰', '🧘'].map((i) => `<option>${i}</option>`).join('')}</select>
          <input class="input" id="g-deadline" type="date" title="截止日期（可选）"/>
        </div>
        <textarea class="input" id="g-ms" rows="4" placeholder="里程碑，每行一个，如：&#10;第 1 个月读完 2 本&#10;第 2 个月读完 2 本&#10;第 3 个月读完 2 本"></textarea>
      </div>
      <div class="modal-btns">
        <button class="btn ghost" id="g-cancel">取消</button>
        <button class="btn" id="g-ok">创建目标</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  $('#g-cancel', mask).onclick = () => mask.remove();
  $('#g-ok', mask).onclick = async () => {
    const title = $('#g-title', mask).value.trim();
    if (!title) return toast('请填写目标名称', '', true);
    const ms = $('#g-ms', mask).value.split('\n').map((s) => s.trim()).filter(Boolean);
    await api.goalAdd({ title, icon: $('#g-icon', mask).value, deadline: $('#g-deadline', mask).value, milestones: ms });
    mask.remove();
    toast('目标已设定', ms.length ? `已拆解为 ${ms.length} 个里程碑` : '去添加里程碑拆解它吧');
  };
  setTimeout(() => $('#g-title', mask).focus(), 50);
}


function applyNetPrefs() {
  if (window.PQLegionNet && typeof PQLegionNet.setNetPrefs === 'function') {
    PQLegionNet.setNetPrefs({ mode: state.settings.netMode, turn: state.settings.netTurn || null });
  }
}

/* 多源冗余版本更新 · 只在桌面版渲染（绿色版才有「换目录」这回事） */
function updatePanelHTML() {
  if (!IS_DESKTOP) return '';
  return `
    <div class="panel" style="margin-top:14px">
      <h3>版本更新</h3>
      <div class="sd" style="line-height:1.7">
        下载源已内置（GitHub / R2 / pixeldrain / MediaFire / GoFile 五源自动切换），
        <b>这里不用填写</b>。要换成自己的源，见安装目录「使用说明.txt」的「安装源」一节。
      </div>
      <div class="form-foot" style="justify-content:flex-start;gap:8px;margin-top:10px">
        <button class="btn" id="pq-up-check">检查更新</button>
      </div>
      <div id="pq-up-result" class="sd" style="margin-top:10px;line-height:1.7">还没有检查过。</div>
      <div class="sd" style="margin-top:10px;line-height:1.7">
        <b>可选大模型（默认都不下载，装到安装文件夹内 components 目录）</b><br/>
        <label style="display:block;margin-top:6px"><input type="checkbox" id="pq-up-ollama" /> Ollama 绿色版（官网 zip 约 1.5 GB，模型另 ollama pull qwen2.5:3b 1.9 GB）</label>
        <label style="display:block;margin-top:4px"><input type="checkbox" id="pq-up-melo" /> MeloTTS 源码（官网无运行包，本机 Python 3.13 跑不起来，勾了只下源码）</label>
        <button class="btn ghost" id="pq-up-comp" style="margin-top:8px">下载所选组件</button>
        <span id="pq-up-comp-msg" class="sd" style="margin-left:8px">不勾选就一个字节都不下。</span>
      </div>
      <div class="form-hint" style="margin-top:10px">
        新版本下到独立目录，<b>不覆盖正在运行的 exe</b>；计划数据在 %APPDATA%\\PlanQuest\\，换版本自动沿用，无需迁移。
        想重装或换版本，用「PlanQuest-安装助手.exe」；它不提权、只解压；开机自启请在上面的开关里开启（会写 HKCU 注册表）。
      </div>
    </div>`;
}

function bindUpdatePanel() {
  if (!IS_DESKTOP) return;
  const chk = $('#pq-up-check');
  if (chk) chk.onclick = async () => {
    const box = $('#pq-up-result');
    box.textContent = '正在检查各源…';
    const r = await api.updateCheck();
    if (!r || !r.ok) { box.textContent = '没查到：' + ((r && r.reason) || '更新模块未加载'); return; }
    if (!r.hasUpdate) { box.textContent = `已是最新版 ${r.current}${r.via ? '（来自 ' + r.via + '）' : ''}。`; return; }
    box.innerHTML = `发现新版本 <b>${esc(r.latest)}</b>（当前 ${esc(r.current)}${r.via ? '，来自 ' + esc(r.via) : ''}）。<br/>` +
      `${esc(String(r.notes || (r.manifest && r.manifest.notes) || '').slice(0, 300))}<br/>` +
      `<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">` +
      `<button class="btn" id="pq-up-install">一键更新</button>` +
      `<button class="btn ghost" id="pq-up-get">只下载</button>` +
      `</div>` +
      `<div class="sd" id="pq-up-stage" style="margin-top:8px;line-height:1.7">一键更新 = 下载 → 校验 → 备份 → 解压 → 自检 → 覆盖；出问题自动还原。数据不迁移。</div>`;
    const stage = () => $('#pq-up-stage');
    const watchStage = () => {
      if (api.onUpdateStage) api.onUpdateStage((t) => { const s = stage(); if (s) s.textContent = t; });
    };
    /* 一键更新：完整流水线 */
    const install = $('#pq-up-install');
    if (install) install.onclick = async () => {
      install.disabled = true; const old = install.textContent; install.textContent = '更新中…';
      const getBtn = $('#pq-up-get'); if (getBtn) getBtn.disabled = true;
      watchStage();
      try {
        const d = await api.updateInstall();
        toast(d && d.ok ? '✅ 更新完成' : '更新没成功', (d && d.message) || '未知结果', !(d && d.ok));
        const s = stage(); if (s) s.textContent = (d && d.message) || '更新结束';
      } catch (e) {
        const s = stage(); if (s) s.textContent = '更新出错：' + ((e && e.message) || e);
      } finally {
        install.disabled = false; install.textContent = old;
        const getBtn = $('#pq-up-get'); if (getBtn) getBtn.disabled = false;
      }
    };
    /* 只下载（保留原入口：下到新目录，用户自己切换） */
    const get = $('#pq-up-get');
    if (get) get.onclick = async () => {
      get.disabled = true; get.textContent = '下载中…';
      watchStage();
      const d = await api.updateDownload();
      get.disabled = false; get.textContent = '只下载';
      toast(d && d.ok ? '✅ 下载完成' : '下载没成功', (d && d.message) || '未知结果', !(d && d.ok));
      const s = stage(); if (s && d && !d.ok) s.textContent = d.message || '下载失败';
    };
  };
  const comp = $('#pq-up-comp');
  if (comp) comp.onclick = async () => {
    const ids = [];
    if ($('#pq-up-ollama') && $('#pq-up-ollama').checked) ids.push('ollama');
    if ($('#pq-up-melo') && $('#pq-up-melo').checked) ids.push('melotts');
    const msg = $('#pq-up-comp-msg');
    if (!ids.length) { msg.textContent = '没勾任何组件，一个字节都不下。'; return; }
    comp.disabled = true; msg.textContent = '正在从官网下载…';
    const r = await api.updateComponents(ids);
    comp.disabled = false;
    msg.textContent = (r && r.message) || '完成';
  };
}

function renderSettings() {
  const s = state.settings;
  /* 护眼节奏：三档预设（工作 → 休息），旧数据回落 45/15 */
  const EYE_PLAN_MAP = { 30: 10, 45: 15, 60: 20 };
  const ecPlan = EYE_PLAN_MAP[Number((state.eyeCare && state.eyeCare.plan) || s.eyeCarePlan)] || 45;
  const ecRest = EYE_PLAN_MAP[ecPlan];
  $('#view').innerHTML = `
    <div class="view-head">
      <div class="view-title">设置</div>
      <div class="view-sub">开机自启 · 提醒 · 外观</div>
    </div>

    ${msgCenterPanelHtml()}

    <div class="panel">
      <h3>启动与提醒</h3>
      ${
        IS_DESKTOP || IS_NATIVE
          ? `
      <div class="set-row">
        <div class="set-info">
          <div class="st">开机自动启动 ${state.autoStartReal ? '<span style="color:var(--accent-2);font-size:11px">（系统已生效）</span>' : ''}</div>
          <div class="sd">${
            IS_DESKTOP
              ? '登录 Windows 后在后台静默运行，到点自动弹窗提醒，不会打开窗口打扰你。'
              : '开机后自动启动提醒服务：计划提醒、护眼计时、守护模式开机就生效。部分手机还需在系统设置里允许本应用「自启动」。'
          }</div>
        </div>
        <div class="switch ${s.autoStart ? 'on' : ''}" data-set="autoStart"></div>
      </div>`
          : ''
      }
      ${
        IS_DESKTOP
          ? `
      <div class="set-row">
        <div class="set-info">
          <div class="st">关闭时最小化到托盘</div>
          <div class="sd">点 × 不退出，挂在托盘里继续提醒；退出请用托盘菜单。</div>
        </div>
        <div class="switch ${s.closeToTray ? 'on' : ''}" data-set="closeToTray"></div>
      </div>`
          : ''
      }
      <div class="set-row">
        <div class="set-info">
          <div class="st">提醒声音</div>
          <div class="sd">弹窗与系统通知时播放提示音。</div>
        </div>
        <div class="switch ${s.sound ? 'on' : ''}" data-set="sound"></div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="st">稍后提醒间隔</div>
          <div class="sd">弹窗点「稍后」后，隔多久再次提醒。</div>
        </div>
        <select class="select" data-setval="snoozeMinutes">
          ${[5, 10, 15, 30].map((m) => `<option value="${m}" ${s.snoozeMinutes === m ? 'selected' : ''}>${m} 分钟</option>`).join('')}
        </select>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="st">连续提醒</div>
          <div class="sd">未打卡时每 2 小时再次弹窗提醒，直到完成或当天忽略。</div>
        </div>
        <div class="switch ${s.repeatRemind ? 'on' : ''}" data-set="repeatRemind"></div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="st">测试提醒</div>
          <div class="sd">立即弹出一个打卡提醒窗口，看看效果。</div>
        </div>
        <button class="btn small" id="test-remind">测试</button>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="st">新手引导</div>
          <div class="sd">首次打开时自动播放一次。想再看一遍，点右边重新播放。</div>
        </div>
        <button class="btn small" id="replay-guide">重新播放</button>
      </div>
    </div>

    ${
      IS_DESKTOP
        ? `
    <div class="panel">
      <h3>专注模式（环境隔离）</h3>
      <div class="set-row">
        <div class="set-info">
          <div class="st">隐藏桌面图标 ${state.focusMode ? '<span style="color:var(--amber);font-size:11px">（已隐藏）</span>' : ''}</div>
          <div class="sd">开启后隐藏桌面全部图标（含娱乐 App），减少视觉诱惑；关闭或退出应用时自动恢复。</div>
        </div>
        <div class="switch ${state.focusMode ? 'on' : ''}" id="focus-switch"></div>
      </div>
    </div>`
        : ''
    }

    ${
      IS_DESKTOP || IS_NATIVE
        ? `
    <div class="panel">
      <h3>护眼模式</h3>
      <div class="set-row">
        <div class="set-info">
          <div class="st">每 ${ecPlan} 分钟眼保健操 + ${ecRest} 分钟息屏 ${
            state.eyeCare && state.eyeCare.phase
              ? '<span style="color:var(--amber);font-size:11px">（进行中 · ' +
                (state.eyeCare.phase === 'exercise' ? '眼保健操' : '息屏') +
                '）</span>'
              : ''
          }</div>
          <div class="sd">开启后每 ${ecPlan} 分钟弹出眼保健操引导，随后强制息屏 ${ecRest} 分钟；
            跳过任一环节、调整护眼节奏、以及开启或关闭护眼模式，都需要输入守护密码。</div>
        </div>
        <div class="switch ${state.eyeCare && state.eyeCare.enabled ? 'on' : ''}" id="eyecare-switch"></div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="st">护眼节奏</div>
          <div class="sd">三档预设：30 分钟 → 休息 10 分钟 · 45 分钟 → 休息 15 分钟 · 60 分钟 → 休息 20 分钟。
            改节奏同样需要守护密码，改完立即按新节奏重新计时（正在进行中的这一轮不变）。</div>
        </div>
        <select class="select" id="eyecare-plan">
          <option value="30" ${ecPlan === 30 ? 'selected' : ''}>30 分钟 · 休息 10 分钟</option>
          <option value="45" ${ecPlan === 45 ? 'selected' : ''}>45 分钟 · 休息 15 分钟</option>
          <option value="60" ${ecPlan === 60 ? 'selected' : ''}>60 分钟 · 休息 20 分钟</option>
        </select>
      </div>
    </div>`
        : ''
    }

    ${pkRepoPanelHTML()}

    ${alaEnginePanelHTML()}

    ${aiTrainPanelHTML()}

    <div class="panel">
      <h3>联机异地设置</h3>
      <div class="set-row">
        <div class="set-info">
          <div class="st">连接方式</div>
          <div class="sd">同时作用于：军团「异地连接」和自习房/娱乐房的「异地联机」。直连优先：点对点直传，最快、不经任何第三方，严格防火墙下可能连不上；房间模式下 STUN 开关仍由你控制。纯中继：全部流量经 TURN 服务器转发，防火墙再严也能连上，代价是多一跳延迟。切换后需重新配对一次才生效。</div>
        </div>
        <select class="select" data-setval="netMode">
          <option value="direct" ${s.netMode !== 'relay' ? 'selected' : ''}>直连优先（WebRTC）</option>
          <option value="relay" ${s.netMode === 'relay' ? 'selected' : ''}>纯中继服务器</option>
        </select>
      </div>
      <div class="set-row" style="align-items:flex-start">
        <div class="set-info">
          <div class="st">⚠️ P2P 联机风险与免责声明</div>
          <div class="sd">
            ① <b>打洞风险：</b>直连模式靠 NAT 打洞在路由器/防火墙上开出一条通往你电脑的直连通道，<b>外部设备有可能借此向你的电脑发送恶意数据包</b>；软件已做两层防护（WebRTC 强制 DTLS 加密 + 消息白名单，非本协议的数据包一律丢弃），但无法替代杀毒软件和系统防火墙。
            ② 直连模式下双方 IP 互相可见；纯中继模式下对端 IP 藏在 TURN 之后，但中继服务器可以看到。
            ③ 只和你<b>信任的人</b>配对：拿到邀请码/连接码的人就能与你建立连接，<b>不要把连接码发到群里或公开场合</b>；怀疑连接码泄露就立刻重新配对。
            ④ 加密边界：军团为 AES-GCM 端到端加密；房间为 WebRTC 自带 DTLS 加密。<b>对方设备上的数据本软件无法保护</b>，联机时不要泄露敏感信息。
            ⑤ 公共 STUN/TURN 由第三方（Google / Cloudflare / openrelay）提供，仅用于转发加密流量；介意者可在上方填自建 coturn 中继。
            ⑥ 免责：使用异地联机 / 军团功能产生的任何数据泄露、损失或与他人纠纷，由使用者自行承担；未成年人请在监护人指导下使用。
          </div>
        </div>
      </div>
      ${
        s.netMode === 'relay'
          ? `<div class="set-row" style="align-items:flex-start">
        <div class="set-info">
          <div class="st">中继服务器（TURN，可选）</div>
          <div class="sd">留空 = 用内置公共中继。有自建 coturn 就填自己的，凭据只存本机 data.json，不会上传。多地址用空格或逗号隔开。</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;min-width:230px">
          <input class="input" id="turn-urls" placeholder="turn:turn.example.com:3478" value="${esc((s.netTurn && s.netTurn.urls) || '')}" />
          <input class="input" id="turn-user" placeholder="用户名（可空）" value="${esc((s.netTurn && s.netTurn.username) || '')}" />
          <input class="input" id="turn-pass" type="password" placeholder="密码（可空）" value="${esc((s.netTurn && s.netTurn.credential) || '')}" />
          <button class="btn small" id="turn-save">保存中继配置</button>
        </div>
      </div>`
          : ''
      }
    </div>

    <div class="panel">
      <h3>外观</h3>
      <div class="set-row">
        <div class="set-info">
          <div class="st">主题</div>
          <div class="sd">深色更适合夜间，浅色更清爽。</div>
        </div>
        <select class="select" data-setval="theme">
          <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>深色</option>
          <option value="light" ${s.theme === 'light' ? 'selected' : ''}>浅色</option>
        </select>
      </div>
    </div>

    ${renderShopPanel()}

    <div class="panel">
      <h3>数据</h3>
      <div class="set-row">
        <div class="set-info">
          <div class="st">数据文件</div>
          <div class="sd">所有计划、打卡记录都保存在本地。</div>
        </div>
        <div class="path-box" title="${esc(state.dataFile)}">${esc(state.dataFile)}</div>
      </div>
      <div class="set-row">
        <div class="set-info"><div class="st">打开数据所在文件夹</div></div>
        <button class="btn small ghost" id="open-folder">打开</button>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="st">计划文件（.pqplan）</div>
          <div class="sd">专用格式，带版本号与 SHA-256 校验和：备份全部计划、打卡记录、目标与契约。顶栏随时可见的「新建 / 导入 / 导出」就是这组功能；桌面版还能直接双击 .pqplan 文件打开。导入可选合并或覆盖。</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn small" id="planfile-new">新建</button>
          <button class="btn small" id="planfile-import">导入</button>
          <button class="btn small ghost" id="planfile-export">导出</button>
        </div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="st">分享给朋友</div>
          <div class="sd">打卡海报 / 应用链接。海报内容默认全部隐藏，必须逐项勾选才会显示——不会把你没选的数据画进去。</div>
        </div>
        <button class="btn small" id="open-share-set">分享</button>
      </div>
    </div>

    ${updatePanelHTML()}
    ${renderCloudPanel()}
    ${lkPanelHTML()}
  `;

  const replayBtn = $('#replay-guide');
  if (replayBtn) replayBtn.onclick = () => {
    if (!window.PQOnboarding || !window.PQOnboarding.shouldShow(state.settings)) {
      // 已看过：从设置里重开，先写回 false 再播
      if (state && state.settings) state.settings.guideDone = false;
      api.updateSettings({ guideDone: false }).catch(() => {});
    }
    if (!Guide.isActive()) Guide.start();
  };

  $$('[data-set]').forEach((el) => {
    el.onclick = async () => {
      const key = el.dataset.set;
      const turningOn = !el.classList.contains('on');
      /* 绿色安装器不写注册表，所以这一步只能由应用自己做，并且先说清楚 */
      if (key === 'autoStart' && turningOn && IS_DESKTOP) {
        const agree = await confirmDialog(
          '开启开机自启会写系统启动项',
          '会在注册表 HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run 写入一条当前用户的启动项（只对你自己生效，不需要管理员权限，也不会改别的地方）。绿色版换目录后，应用下次启动会自动把启动项指向新位置；关掉本开关会删除这条。'
        );
        if (!agree) return;
      }
      await api.updateSettings({ [key]: turningOn });
      if (key === 'autoStart' && turningOn) toast('已开启开机自启', '下次开机在后台运行，HKCU Run 启动项已写入');
      if (key === 'autoStart' && !turningOn) toast('已关闭开机自启', '启动项已删除');
    };
  });
  bindUpdatePanel();
  bindMsgCenterPanel();
  $$('[data-setval]').forEach((el) => {
    el.onchange = async () => {
      const key = el.dataset.setval;
      const r = await api.updateSettings({ [key]: el.value });
      if (key === 'netMode') {
        if (r && r.settings) Object.assign(state.settings, r.settings);
        applyNetPrefs();
        renderSettings();
      }
    };
  });
  const turnSave = $('#turn-save');
  if (turnSave) {
    turnSave.onclick = async () => {
      const urls = $('#turn-urls').value.trim();
      const patch = {
        netTurn: urls
          ? { urls, username: $('#turn-user').value.trim(), credential: $('#turn-pass').value }
          : null,
      };
      const r = await api.updateSettings(patch);
      if (r && r.settings) Object.assign(state.settings, r.settings);
      applyNetPrefs();
      toast(urls ? '中继配置已保存，重新配对后生效' : '已改回内置公共中继，重新配对后生效');
    };
  }
  const pkSave = $('#pk-save');
  if (pkSave) {
    /* token 不用手填：优先读环境变量、gh CLI、git 凭据，读到了就只显示来源与掩码 */
    const paintToken = async (refresh) => {
      const el = $('#pk-token-state');
      if (!el) return;
      const r = refresh && api.pkTokenRefresh ? await api.pkTokenRefresh() : await api.pkToken();
      const label = { env: '环境变量', gh: 'GitHub CLI', git: '系统 git 凭据', stored: '本机设置', none: '未检测到' };
      if (r && r.ok) {
        el.innerHTML = `已自动识别：<b>${label[r.source] || r.source}</b> · ${esc(r.masked || '')}　<span style="opacity:.7">（不用手填，换机器重新登录一次即可）</span>`;
      } else {
        el.innerHTML = esc((r && r.hint) || '未检测到本机凭据，可以手动填一个。');
      }
    };
    const autoBtn = $('#pk-token-auto');
    if (autoBtn) autoBtn.onclick = () => paintToken(true);
    paintToken(false);

    /* ---- GitHub 官方 OAuth（Device Flow）---- */
    if (window.__pkPoll) {
      clearInterval(window.__pkPoll);
      window.__pkPoll = null;
    }
    const codeBox = $('#pk-oauth-code');
    const loginBtn = $('#pk-oauth-login');
    const openLink = $('#pk-oauth-app-link');
    if (openLink)
      openLink.onclick = (e) => {
        e.preventDefault();
        api.openExternal('https://github.com/settings/developers');
      };

    const showCode = (r) => {
      if (!codeBox) return;
      codeBox.style.display = '';
      codeBox.innerHTML = `在浏览器里打开 <b>${esc(r.verify)}</b>，输入 <b style="font-size:16px;letter-spacing:3px">${esc(
        r.userCode
      )}</b>　<button class="btn ghost" id="pk-oauth-open" type="button">打开浏览器</button><button class="btn ghost" id="pk-oauth-copy" type="button">复制验证码</button><span id="pk-oauth-hint" style="opacity:.7"> · 等待确认…</span>`;
      const ob = $('#pk-oauth-open');
      if (ob) ob.onclick = () => api.openExternal(r.verify);
      const cb = $('#pk-oauth-copy');
      if (cb)
        cb.onclick = () => {
          copyText(r.userCode);
          toast('已复制', '粘到 GitHub 页面里');
        };
    };

    if (loginBtn)
      loginBtn.onclick = async () => {
        const r = await api.pkOauthStart();
        if (!r.ok) {
          toast('还不能登录', r.message || '', true);
          if (r.status === 'no_client') {
            const d = document.querySelector('#pk-oauth-client');
            if (d) d.focus();
          }
          return;
        }
        showCode(r);
        let interval = Math.max(5, Number(r.interval) || 5) * 1000;
        if (window.__pkPoll) clearInterval(window.__pkPoll);
        const tick = async () => {
          const s = await api.pkOauthPoll();
          const hint = $('#pk-oauth-hint');
          if (s.status === 'pending') return;
          if (s.status === 'slow') {
            interval = Math.min(30000, interval + 5000);
            if (hint) hint.textContent = ' · GitHub 要求放慢轮询，已自动降频…';
            clearInterval(window.__pkPoll);
            window.__pkPoll = setInterval(tick, interval);
            return;
          }
          clearInterval(window.__pkPoll);
          window.__pkPoll = null;
          if (s.status === 'ok') {
            toast('已登录 GitHub', `授权成功 ${s.masked || ''}，之后同步不用再登录`);
            renderSettings();
            return;
          }
          toast('登录没完成', s.message || '重试一次', true);
        };
        window.__pkPoll = setInterval(tick, interval);
      };

    const outBtn = $('#pk-oauth-out');
    if (outBtn)
      outBtn.onclick = async () => {
        const ok2 = await confirmDialog('退出 GitHub 登录？', '退出后布告栏无法同步，重新登录一次即可恢复。');
        if (!ok2) return;
        await api.pkOauthLogout();
        toast('已退出登录', '账号里的仓库不受影响');
        renderSettings();
      };

    const saveClient = $('#pk-oauth-save');
    if (saveClient)
      saveClient.onclick = async () => {
        const clientId = ($('#pk-oauth-client').value || '').trim();
        const r = await api.updateSettings({ pkOAuth: { clientId } });
        if (r && r.settings) Object.assign(state.settings, r.settings);
        toast(clientId ? 'Client ID 已保存' : '已清空 Client ID', clientId ? '现在可以点「用 GitHub 登录」' : '');
        renderSettings();
      };

    pkSave.onclick = async () => {
      const r = await api.updateSettings({
        pkRepo: {
          owner: $('#pk-owner').value.trim(),
          repo: $('#pk-repo').value.trim(),
          branch: $('#pk-branch').value.trim() || 'main',
          token: $('#pk-token').value.trim(),
          backup: {
            owner: $('#pk-bak-owner').value.trim(),
            repo: $('#pk-bak-repo').value.trim(),
            branch: $('#pk-bak-branch').value.trim() || 'main',
          },
        },
      });
      if (r && r.settings) Object.assign(state.settings, r.settings);
      const hasRepo = !!(r && r.settings && r.settings.pkRepo && r.settings.pkRepo.repo);
      toast(
        hasRepo ? '布告栏已保存' : '还差仓库名',
        hasRepo ? '下次同步就会往私有仓库写；只上传聚合数字' : 'owner/repo 必填，token 可以留空自动读取'
      );
      $('#pk-token').value = '';
      if (hasRepo) paintToken(true);
      renderSettings();
    };
  }
  $('#test-remind').onclick = async () => {
    const r = await api.testReminder();
    if (!r.ok) toast(r.message, '', true);
  };
  const focusSwitch = $('#focus-switch');
  if (focusSwitch) {
    focusSwitch.onclick = async () => {
      const want = !focusSwitch.classList.contains('on');
      const r = await api.focusToggle(want);
      if (r.ok) {
        toast(
          want ? '🔒 专注模式已开启' : '桌面图标已恢复',
          want
            ? r.restarted
              ? '已隐藏桌面图标（切换时任务栏闪一下属正常）'
              : '桌面图标已隐藏，关闭时自动恢复'
            : r.restarted
              ? '桌面图标已恢复（任务栏闪一下属正常）'
              : ''
        );
      } else {
        toast(r.message || '操作失败', '可在 %APPDATA%\\PlanQuest\\focus.log 查看原因', true);
      }
    };
  }
  const eyeCareSwitch = $('#eyecare-switch');
  if (eyeCareSwitch) {
    eyeCareSwitch.onclick = async () => {
      const want = !eyeCareSwitch.classList.contains('on');
      const pw = await askPassword(want ? '开启护眼模式需验证' : '关闭护眼模式需验证');
      if (pw === null) return;
      const r = await api.eyeCareToggle({ enabled: want, password: pw });
      if (!r.ok || r.needPassword) return toast('密码不对', '护眼模式设置未生效', true);
      // 立即刷新界面（开关状态 + 「进行中」标记）
      state = await api.getState();
      renderSettings();
      toast(
        want ? '👁 护眼模式已开启' : '护眼模式已关闭',
        want ? `${ecPlan} 分钟后第一次提醒 · 每轮：眼保健操 + 息屏 ${ecRest} 分钟` : ''
      );
    };
  }
  const eyeCarePlanSel = $('#eyecare-plan');
  if (eyeCarePlanSel) {
    eyeCarePlanSel.onchange = async () => {
      const prev = String(ecPlan);
      const want = eyeCarePlanSel.value;
      const pw = await askPassword('调整护眼节奏需验证');
      if (pw === null) { eyeCarePlanSel.value = prev; return; }
      const r = await api.eyeCarePlan({ plan: Number(want), password: pw });
      if (!r.ok) {
        eyeCarePlanSel.value = prev;
        return toast(r.needPassword ? '密码不对' : (r.message || '操作失败'), '护眼节奏未修改', true);
      }
      state = await api.getState();
      renderSettings();
      toast('护眼节奏已调整', `${want} 分钟 → 休息 ${r.restMin || ({ 30: 10, 45: 15, 60: 20 })[want]} 分钟`);
    };
  }
  $('#open-folder').onclick = () => api.openDataFolder();
  const pfNew = $('#planfile-new');
  const pfExport = $('#planfile-export');
  const pfImport = $('#planfile-import');
  if (pfNew) pfNew.onclick = () => planFileNew();
  if (pfExport) pfExport.onclick = () => planFileExport();
  if (pfImport) pfImport.onclick = () => planFileImport();
  const shareSetBtn = $('#open-share-set');
  if (shareSetBtn) shareSetBtn.onclick = () => openSharePanel();
  bindShopPanel();
  bindCloudPanel();
  bindLkPanel();
  bindAiTrainPanel();
  bindAlaEnginePanel();
}

/* ================= 计划文件（.pqplan）：顶栏常驻 [新建][导入][导出] =================
 * 这三个按钮在所有页面都可见（标题栏里），设置页还留了一份，
 * 桌面版 / 网页版 / 安卓版共用同一套逻辑，差别只在 api-bridge 的实现。
 */

const PLAN_FILE_BTNS = [
  { act: 'new', ico: '＋', label: '新建', title: '新建空白计划文件（.pqplan）' },
  { act: 'import', ico: '↓', label: '导入', title: '导入计划文件（.pqplan），可选合并或覆盖' },
  { act: 'export', ico: '↑', label: '导出', title: '导出计划文件（.pqplan），备份到指定位置' },
];

function planFileBarHTML() {
  return (
    '<div class="tb-file" id="plan-file-bar">' +
    PLAN_FILE_BTNS.map(
      (b) =>
        `<button class="tb-file-btn" data-pf="${b.act}" title="${esc(b.title)}"><i>${b.ico}</i><span>${b.label}</span></button>`
    ).join('') +
    '</div>'
  );
}

/* 标题栏里插一组文件按钮（幂等：重复调用不会插第二组） */
function mountPlanFileBar() {
  const tb = document.querySelector('.titlebar');
  if (!tb || document.getElementById('plan-file-bar')) return;
  const anchor = tb.querySelector('.tb-left') || tb;
  anchor.insertAdjacentHTML('beforeend', planFileBarHTML());
  const bar = document.getElementById('plan-file-bar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pf]');
    if (!btn) return;
    const act = btn.dataset.pf;
    if (act === 'new') planFileNew();
    else if (act === 'import') planFileImport();
    else if (act === 'export') planFileExport();
  });
}

/* 新建：桌面版弹「另存为」写空白模板；网页/手机版直接下载空白模板 */
async function planFileNew() {
  if (typeof api.planfileNew !== 'function') {
    toast('当前平台不支持新建计划文件', '', true);
    return;
  }
  const r = await api.planfileNew();
  if (!r || r.canceled) return;
  if (r.ok) toast('已新建空白计划文件', r.path || '');
  else toast('新建失败', (r && r.message) || '', true);
}

/* 导入/导出的范围选择弹窗：返回 'all' | 'normal' | 'contract' | null */
async function pickScopeDialog(title) {
  const v = await chooseDialog(
    title,
    '普通计划：不带契约标记的日常计划；契约计划：契约项目与项目里的子任务（含各自的打卡记录）。',
    [
      { label: '全部内容' },
      { label: '仅普通计划' },
      { label: '仅契约计划' },
      { label: '取消', ghost: true },
    ]
  );
  return ['all', 'normal', 'contract'][v] ?? null;
}

/* 导出：普通计划 / 契约计划 / 军团元数据 并列为选项，一次弹窗问清 */
async function planFileExport() {
  let legionMeta = null;
  try {
    if (window.PQLegion && typeof PQLegion.exportMeta === 'function') legionMeta = PQLegion.exportMeta();
  } catch (_) {}

  const opts = [{ label: '全部内容' }, { label: '仅普通计划' }, { label: '仅契约计划' }];
  if (legionMeta) {
    opts.push({ label: '全部内容 + 军团元数据' });
    opts.push({ label: '仅军团元数据' });
  }
  opts.push({ label: '取消', ghost: true });
  const desc = legionMeta
    ? '普通计划：不带契约标记的日常计划；契约计划：契约项目与项目里的子任务。\n军团元数据：只带军团码 / 我的代号 / 上报节奏等身份字段，不含任何打卡明细，用于换设备接着打。\n注意：带元数据的文件等于你的军团身份，只用于自己的备份。'
    : '普通计划：不带契约标记的日常计划；契约计划：契约项目与项目里的子任务（含各自的打卡记录）。';
  const v = await chooseDialog('导出计划文件 · 选择内容', desc, opts);
  if (v < 0 || v === opts.length - 1) return;

  const map = legionMeta
    ? ['all', 'normal', 'contract', 'all+legion', 'meta']
    : ['all', 'normal', 'contract'];
  const pick = map[v];
  const scope = pick === 'all+legion' ? 'all' : pick;
  const withLegion = pick === 'all+legion' || pick === 'meta' ? legionMeta : null;
  const r = await api.planfileExport(scope, withLegion);
  if (!r) return;
  if (r.ok) toast(pick === 'meta' ? '军团元数据已导出' : withLegion ? '计划文件已导出（含军团元数据）' : '计划文件已导出', r.path || '');
  else if (!r.canceled) toast('导出失败', (r && r.message) || '', true);
}

/* ================= .pqplan 覆盖：阿刺审讯 / 编辑不应用 / 扣刺播报 / 翻旧账 =================
 * 口径：新增计划按新建扣分、覆盖掉的按删除扣分；只打开编辑不扣分不应用；
 *      覆盖必须过审讯，点确认才扣刺 + 记逃兵标签，点取消啥事没有。 */

function PO() { return window.PQPlanOverwrite || null; }

function overwriteSay(text, mood, toastText, cover) {
  try {
    /* 顶罪演出：系统先报「检测到违规操作，扣除 N 积分」，
     * 隔半秒阿刺自己跳出来插话 —— 扛不扛由他定，界面不摆概率、不给开关。 */
    if (cover && cover.systemNotice) {
      if (window.PQBuddy && typeof PQBuddy.push === 'function') PQBuddy.push('sys', cover.systemNotice);
      toast('系统判定', String(cover.systemNotice), true);
    }
    const delay = cover ? 560 : 0;
    setTimeout(function () {
      if (window.PQBuddy && typeof PQBuddy.say === 'function') {
        PQBuddy.say(String(text || ''), (cover && cover.covered) ? 'smirk' : (mood || 'sideeye'));
      }
    }, delay);
  } catch (_) {}
  if (toastText) toast('阿刺动手了', String(toastText), true);
}

/* 冻结标记给 buddy.js 用：第 3 次覆盖起，换皮 / 养成 24 小时不让碰 */
function applyOverwriteState(st) {
  if (!st) return;
  window.PQOverwriteFrozen = !!st.frozen;
  window.PQOverwriteState = st;
}

/* 审讯明细在本机预估：和主进程 applyOverwrite 用的是同一份纯函数 */
function overwritePreview(picked, mode, scope) {
  const m = PO();
  if (!m) return null;
  const cur = (state && state.plans) || [];
  const inc = (picked && picked.data && picked.data.plans) || [];
  const diff = m.diffPlans(cur, inc, mode, scope);
  const ctx = {
    whitelist: (state && state.guard && state.guard.whitelist) || [],
    points: (state && state.profile && state.profile.points) || 0,
    aciLevel: (state && state.aci && state.aci.level) || 1,
    at: Date.now(), source: (picked && picked.source) || '',
  };
  const cost = m.baseCost(diff, ctx);
  const plan = m.assess((state && state.overwrite) || m.defaultState(), diff, ctx, ctx.at);
  /* 审讯明细要跟主进程一致：把当前皮肤的利弊倍率算进去 */
  const perk = window.PQPerk;
  const skinId = (window.PQBuddy && typeof PQBuddy.currentSkin === 'function') ? PQBuddy.currentSkin() : '';
  const shaped = (perk && typeof perk.shapePlan === 'function') ? perk.shapePlan(plan, skinId, ctx) : null;
  const effPlan = shaped ? shaped.plan : plan;
  return { diff, ctx, cost, plan: effPlan, inq: m.interrogation(diff, effPlan, cost, ctx) };
}

/* 覆盖后强制「阿刺审讯」：确认扣积分 + 记逃兵标签，取消啥事没有 */
function interrogateDialog(inq, plan) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask pq-inq-mask';
    const emoji = (state && state.profile && state.profile.avatar) || '🌵';
    mask.innerHTML = `
      <div class="modal pq-inq" style="width:470px">
        <div class="pq-inq-head">
          <div class="pq-inq-face">${esc(emoji)}</div>
          <div class="pq-inq-titles">
            <h2>${esc(inq.title)}</h2>
            <div class="pq-inq-sub">阿刺 · 覆盖审讯中 · 笑得越甜，扎得越深</div>
          </div>
        </div>
        <div class="pq-inq-lead">${esc(inq.lead)}</div>
        <div class="pq-inq-buy">${esc(inq.buyRoad)}</div>
        <ul class="pq-inq-list">${(inq.details || []).map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
        <div class="pq-inq-tier">第 ${plan.count} 次覆盖 · 第 ${plan.tier} 档赎罪${plan.lock ? ' · 换皮 / 养成锁死 24 小时' : ''}${plan.demote ? ' · 等级掉回新手' : ''}</div>
        <div class="form-foot">
          <button class="btn ghost" data-r="0">${esc(inq.cancel)}</button>
          <button class="btn pq-inq-yes" data-r="1">${esc(inq.confirm)}</button>
        </div>
      </div>`;
    mask.addEventListener('click', (e) => {
      const r = e.target.closest('[data-r]')?.dataset.r;
      if (r !== undefined) { mask.remove(); resolve(r === '1'); }
      else if (e.target === mask) { mask.remove(); resolve(false); }
    });
    $('#modal-root').appendChild(mask);
  });
}

/* 只打开 .pqplan 编辑：可改、可另存，绝不应用到本机、绝不扣分、不进审讯 */
function openPlanEditor(picked) {
  return new Promise((resolve) => {
    const json = JSON.stringify((picked && picked.data) || {}, null, 2);
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="width:640px">
        <h2>只打开编辑 · 不应用</h2>
        <p style="font-size:13px;color:var(--text-2);line-height:1.6">（斜眼笑）光看不应用？行吧，本刺今天不拔刺。改完可以另存为 .pqplan，但不会写进本机计划，也不会扣你一分。</p>
        <textarea class="input pq-inq-editor" id="pq-inq-json" spellcheck="false">${esc(json)}</textarea>
        <div class="form-foot">
          <button class="btn ghost" data-r="0">关闭</button>
          <button class="btn" data-r="1">另存为 .pqplan</button>
        </div>
      </div>`;
    mask.addEventListener('click', async (e) => {
      const r = e.target.closest('[data-r]')?.dataset.r;
      if (r === undefined) {
        if (e.target === mask) { mask.remove(); resolve(false); }
        return;
      }
      if (r === '0') { mask.remove(); resolve(false); return; }
      let obj = null;
      try { obj = JSON.parse(mask.querySelector('#pq-inq-json').value); }
      catch (err) { toast('JSON 写坏了', err.message, true); return; }
      if (!obj || !Array.isArray(obj.plans)) { toast('结构不对', '至少要有一个 plans 数组', true); return; }
      try {
        const saved = await api.planfileSaveEnvelope({ filePath: picked.filePath || null, data: obj });
        if (saved && saved.ok) toast('已另存，本机没动', saved.path || '文件已保存 · 不扣分、不应用');
        else if (!saved || !saved.canceled) toast('保存失败', (saved && saved.message) || '', true);
      } catch (err) { toast('保存失败', err.message, true); }
      mask.remove();
      resolve(true);
    });
    $('#modal-root').appendChild(mask);
  });
}

/* 启动翻旧账 + 主进程（双击 .pqplan）播报通道 */
function initOverwrite() {
  if (!window.api) return;
  if (typeof api.onOverwriteSay === 'function') {
    api.onOverwriteSay((p) => { if (p && p.text) overwriteSay(p.text, p.mood, p.toast, p.cover); });
  }
  if (typeof api.overwriteBoot === 'function') {
    api.overwriteBoot().then((r) => {
      if (!r) return;
      applyOverwriteState(r.state);
      if (r.line) setTimeout(() => overwriteSay(r.line, r.mood, '本刺翻旧账了'), 1500);
    }).catch(() => {});
  }
}

/* 导入：选文件 → 校验 → 选范围/方式 → 覆盖先审讯 → 应用；文件坏了给「按空白模版填充」的出口 */
async function planFileImport() {
  const picked = await api.planfilePick();
  if (!picked || !picked.ok) {
    if (picked && picked.canceled) return;
    // 文件是空的 / 结构不对 / 校验失败 → 提供空白模版填充（修复该文件）
    const msg = (picked && picked.message) || '文件无法读取';
    const fix = await chooseDialog(
      '文件存在问题',
      `${msg}\n\n是否按空白模版填充？填充会写入一个全新的空白 .pqplan，可用本应用继续编辑。`,
      [{ label: '按空白模版填充' }, { label: '取消', ghost: true }]
    );
    if (fix === 0) {
      const r = await api.planfileBlankTemplate(picked && picked.filePath);
      if (r && r.ok) toast('已按空白模版填充', r.path || '已生成空白模板文件');
      else toast('填充失败', (r && r.message) || '', true);
    }
    return;
  }
  /* 纯军团元数据文件：没有计划，直接问要不要恢复身份（换设备接着打） */
  if (picked.legion && !(picked.data.plans || []).length) {
    const v = await chooseDialog(
      '这个文件只有军团元数据',
      '文件里带了军团身份（军团码 / 我的代号 / 上报节奏），没有计划内容。恢复后不用重新建团或申请加入：局域网模式直接连接即可，异地连接需要重新配对一次。',
      [{ label: '恢复军团身份' }, { label: '取消', ghost: true }]
    );
    if (v === 0) {
      try {
        PQLegion.importMeta(picked.legion);
        toast('军团身份已恢复', '局域网直接连接即可；异地连接需重新配对一次');
      } catch (_) {}
    }
    return;
  }
  const scope = await pickScopeDialog(`导入计划文件（${picked.source || '.pqplan'}）· 选择范围`);
  if (!scope) return;
  const nNormal = (picked.data.plans || []).filter((p) => !p.contract).length;
  const nContract = (picked.data.plans || []).filter((p) => p.contract).length;
  const scopeName = scope === 'normal' ? `仅普通计划（${nNormal} 个）` : scope === 'contract' ? `仅契约计划（${nContract} 个任务 · ${(picked.data.contractProjects || []).length} 个项目）` : `全部内容（${nNormal + nContract} 个计划）`;
  const pickMode = await chooseDialog(
    `导入方式 · ${scopeName}`,
    '合并导入：与现有数据去重合入，本机已有的记录优先，新增计划按新建口径扣分；\n覆盖导入：用文件里的这一类计划替换本机同类计划 —— 要过阿刺审讯，要扣刺，旧计划加密留痕；\n只打开编辑：看看 / 改改文件，不应用到本机，也不扣一分。',
    [
      { label: '合并导入（推荐）' },
      { label: '覆盖导入（替换同类计划）' },
      { label: '只打开编辑（不应用·不扣分）', ghost: true },
    ]
  );
  /* 只打开编辑：不扣分、不应用、不记账、不进审讯 */
  if (pickMode === 2) {
    await openPlanEditor(picked);
    const m = PO();
    if (m) overwriteSay(m.LINES.inspect, 'sideeye', '');
    return;
  }
  if (pickMode !== 0 && pickMode !== 1) return;
  const mode = pickMode === 1 ? 'replace' : 'merge';

  /* 覆盖后别静默通过：先让阿刺质问，点确认才往下走，点取消啥事没有 */
  let confirmed = false;
  if (mode === 'replace') {
    const pv = overwritePreview(picked, 'replace', scope);
    if (pv && pv.inq) confirmed = await interrogateDialog(pv.inq, pv.plan);
    else confirmed = await confirmDialog('确认覆盖？', '你那点破计划我可都记着，删了也得挨扎。');
    if (!confirmed) {
      const m = PO();
      overwriteSay(m ? m.line('cancel', {}, Math.random) : '（笑眯眯把刺收回去）算你识相。', 'sideeye', '');
      return;
    }
  }

  const r = await api.planfileApply({
    data: picked.data, checksum: picked.checksum, mode, scope, confirmed,
    source: picked.source || '',
  });
  if (r && r.needConfirm) {
    toast('阿刺拦下来了', '覆盖必须先过审讯', true);
    return;
  }
  if (r.ok) {
    toast(mode === 'replace' ? '已覆盖导入 · 挨扎了' : '已合并导入', r.message || '');
    if (r.say) overwriteSay(r.say, r.mood, r.toast, r.cover);
    applyOverwriteState(r.state);
    state = await api.getState();
    render(true, true);
    /* 文件里带了军团元数据 → 问一下要不要恢复军团身份（换设备接着打） */
    if (picked.legion && window.PQLegion && typeof PQLegion.importMeta === 'function') {
      const v = await chooseDialog(
        '恢复军团身份？',
        '这个文件里带了军团元数据（军团码 / 我的代号 / 上报节奏）。恢复后不用重新建团或申请加入：局域网模式直接连接军团即可，异地连接需要重新配对一次。',
        [{ label: '恢复军团身份' }, { label: '暂不', ghost: true }]
      );
      if (v === 0) {
        try {
          PQLegion.importMeta(picked.legion);
          toast('军团身份已恢复', '局域网直接连接即可；异地连接需重新配对一次');
        } catch (_) {}
      }
    }
  } else {
    toast('导入失败', r.message || '', true);
  }
}

/* ================= 云同步（跨设备共用同一个云账号） ================= */

function renderCloudPanel() {
  try {
    return window.PQCloud && PQCloud.panelHTML ? PQCloud.panelHTML() : '';
  } catch (e) {
    return '';
  }
}

function bindCloudPanel() {
  if (!window.PQCloud || !PQCloud.bindPanel) return;
  PQCloud.bindPanel({ rerender: renderSettings, toast, confirm: confirmDialog });
}

/* ================= 局域网语音（WebRTC 点对点，不需要任何服务器） =================
 * 自习房 / 娱乐房通用。信令走已有的房间 TCP 通道（房主只转发 SDP / ICE），
 * 音频走 WebRTC 直连（DTLS-SRTP 加密），同一 WiFi 内不需要 STUN/TURN。
 * 规则：一对成员里 id 小的负责发 offer，大的发「求 offer」信号，避免同时发起打架。
 */
const lanVoice = { on: false, stream: null, peers: new Map() };

function lanVoiceMyId() {
  return (state && state.room && state.room.myId) || null;
}

function lanVoiceDrop(id) {
  const p = lanVoice.peers.get(id);
  if (!p) return;
  lanVoice.peers.delete(id);
  try { p.pc.close(); } catch (_) {}
  if (p.audio) {
    try { p.audio.srcObject = null; p.audio.remove(); } catch (_) {}
  }
}

function lanVoiceNewPeer(id, withOffer) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const entry = { pc, audio: null, remoteSet: false };
  lanVoice.peers.set(id, entry);

  if (lanVoice.stream) {
    for (const t of lanVoice.stream.getTracks()) pc.addTrack(t, lanVoice.stream);
  }
  pc.onicecandidate = (e) => {
    // RTCIceCandidate 过不了 IPC 的结构化克隆（会变成空对象），这里拆成纯数据
    if (e.candidate) api.roomRtc({ to: id, data: { t: 'ice', c: plainIce(e.candidate) } });
  };
  pc.ontrack = (e) => {
    if (!entry.audio) {
      entry.audio = new Audio();
      entry.audio.autoplay = true;
      entry.audio.style.display = 'none';
      document.body.appendChild(entry.audio);
    }
    entry.audio.srcObject = e.streams[0] || new MediaStream([e.track]);
    entry.audio.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') lanVoiceDrop(id);
  };

  if (withOffer) {
    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        api.roomRtc({ to: id, data: { t: 'offer', sdp: plainSdp(pc.localDescription) } });
      } catch (_) {}
    })();
  }
  return entry;
}

/* 信令过 IPC：RTCSessionDescription / RTCIceCandidate 的字段挂在原型上，
 * 结构化克隆会得到一个空对象（对方 setRemoteDescription({}) 直接抛错），
 * 所以必须手动拆成普通对象再发。 */
function plainSdp(d) {
  if (!d) return null;
  return { type: d.type, sdp: d.sdp };
}

function plainIce(c) {
  if (!c) return null;
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid,
    sdpMLineIndex: c.sdpMLineIndex,
    usernameFragment: c.usernameFragment || undefined,
  };
}

async function lanVoiceSignal(from, data) {
  if (!from || !data) return;
  const myId = lanVoiceMyId();
  if (!lanVoice.on || !myId || from === myId) return;
  try {
    if (data.t === 'need-offer') {
      // 对方想连我，但按规则该我发 offer
      if (String(myId) < String(from)) {
        lanVoiceDrop(from);
        lanVoiceNewPeer(from, true);
      }
      return;
    }
    if (data.t === 'offer') {
      const sdp = plainSdp(data.sdp);
      if (!sdp || !sdp.type || !sdp.sdp) return;
      let entry = lanVoice.peers.get(from);
      // 已在协商中/已连上又收到 offer：直接重建，避免 setRemoteDescription 状态报错
      if (entry && entry.pc.signalingState !== 'stable') {
        lanVoiceDrop(from);
        entry = null;
      }
      if (!entry) entry = lanVoiceNewPeer(from, false);
      await entry.pc.setRemoteDescription(sdp);
      entry.remoteSet = true;
      // ICE 可能先到，补一下
      for (const c of entry.pendingIce || []) {
        try { await entry.pc.addIceCandidate(c); } catch (_) {}
      }
      entry.pendingIce = [];
      const ans = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(ans);
      api.roomRtc({ to: from, data: { t: 'answer', sdp: plainSdp(entry.pc.localDescription) } });
      return;
    }
    const entry = lanVoice.peers.get(from);
    if (!entry) return;
    if (data.t === 'answer') {
      const sdp = plainSdp(data.sdp);
      if (!sdp || !sdp.type || !sdp.sdp) return;
      if (entry.pc.signalingState === 'have-local-offer') {
        await entry.pc.setRemoteDescription(sdp);
        entry.remoteSet = true;
        for (const c of entry.pendingIce || []) {
          try { await entry.pc.addIceCandidate(c); } catch (_) {}
        }
        entry.pendingIce = [];
      }
      return;
    }
    if (data.t === 'ice') {
      if (!data.c || !data.c.candidate) return;
      if (!entry.remoteSet) {
        entry.pendingIce = entry.pendingIce || [];
        entry.pendingIce.push(data.c);
        return;
      }
      try { await entry.pc.addIceCandidate(data.c); } catch (_) {}
    }
  } catch (e) {
    console.log('[lanVoice] ' + ((e && e.message) || e));
  }
}

/* 与当前成员列表对齐：新成员建连、离开的拆掉 */
function syncLanVoicePeers(force) {
  if (!lanVoice.on || !roomJoined) return;
  const myId = lanVoiceMyId();
  if (!myId) return;
  const ids = (roomMembers || []).filter((m) => m.id && m.id !== myId).map((m) => m.id);
  for (const id of ids) {
    if (force) lanVoiceDrop(id);
    if (lanVoice.peers.has(id)) continue;
    if (String(myId) < String(id)) lanVoiceNewPeer(id, true);
    else api.roomRtc({ to: id, data: { t: 'need-offer' } });
  }
  for (const id of [...lanVoice.peers.keys()]) {
    if (!ids.includes(id)) lanVoiceDrop(id);
  }
}

async function lanVoiceStart() {
  if (lanVoice.on) return;
  try {
    lanVoice.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (e) {
    toast('麦克风打不开', '请在系统设置里允许 PlanQuest 使用麦克风', true);
    return;
  }
  lanVoice.on = true;
  syncLanVoicePeers(true);
  /* 本地语音转文字 → 闲聊雷达（同一模型同一规则，音频不出设备） */
  if (window.VoiceASR) {
    VoiceASR.attach(lanVoice.stream, judgeVoiceText).catch(() => {});
  }
  toast('🎤 已开麦', '房间里的成员现在能听到你说话');
  if (currentView === 'study') renderStudy();
}

function lanVoiceStop(silent) {
  const was = lanVoice.on;
  lanVoice.on = false;
  for (const id of [...lanVoice.peers.keys()]) lanVoiceDrop(id);
  lanVoice.peers.clear();
  if (window.VoiceASR) VoiceASR.detach();
  if (lanVoice.stream) {
    lanVoice.stream.getTracks().forEach((t) => t.stop());
    lanVoice.stream = null;
  }
  if (was && !silent) {
    toast('🔇 已闭麦', '其他人听不到你了');
    if (currentView === 'study') renderStudy();
  }
}

function lanVoiceToggle() {
  if (lanVoice.on) lanVoiceStop(false);
  else lanVoiceStart();
}

/* ================= 连麦语音（LiveKit，房主配置） ================= */

function lkPanelHTML() {
  return `
    <div class="panel">
      <h3>连麦语音 <span class="tag">开房间用</span></h3>
      <div class="sd" style="margin:4px 0 10px">
        你开房间时，成员能跟你和其他人实时语音。到
        <b>cloud.livekit.io</b> 免费注册一个项目，在 Settings → Keys 里建一个 Key，
        把下面三项填进来（密钥只存在这台电脑上，成员拿到的是限房间限时的门票）。
        不配置也不影响房间，只是没有语音。
      </div>
      <div class="cloud-form" style="grid-template-columns:1fr">
        <input class="input" id="lk-url" placeholder="URL，如 wss://xxxx.livekit.cloud" />
        <input class="input" id="lk-key" placeholder="API Key" autocomplete="off" />
        <input class="input" id="lk-secret" placeholder="API Secret" type="password" autocomplete="off" />
      </div>
      <div class="cloud-msg" id="lk-msg"></div>
      <div style="display:flex;gap:8px">
        <button class="btn small" id="lk-save">保存</button>
        <button class="btn small ghost" id="lk-clear">清除</button>
      </div>
    </div>
  `;
}

async function bindLkPanel() {
  const urlEl = $('#lk-url');
  if (!urlEl) return;
  // await 之后 DOM 可能已被其它视图替换（快速切页竞态），
  // 每次取元素都重新查询并判空，绝不给 null 绑事件。
  const $lk = (sel) => document.querySelector(sel);
  try {
    const s = await api.livekitStatus();
    if (s && s.configured) {
      if (!urlEl.isConnected) return; // 视图已被替换，本次绑定作废
      urlEl.value = s.url || '';
      const keyEl = $lk('#lk-key');
      const msgEl = $lk('#lk-msg');
      if (keyEl) keyEl.value = s.apiKey || '';
      if (msgEl) msgEl.textContent = '已配置，开房间时成员可连麦。';
    }
  } catch (e) {}
  const saveEl = $lk('#lk-save');
  const clearEl = $lk('#lk-clear');
  if (!saveEl || !clearEl || !urlEl.isConnected) return;
  saveEl.onclick = async () => {
    const r = await api.livekitConfig({
      url: urlEl.value.trim(),
      apiKey: ($lk('#lk-key') || {}).value !== undefined ? $lk('#lk-key').value.trim() : '',
      apiSecret: ($lk('#lk-secret') || {}).value !== undefined ? $lk('#lk-secret').value.trim() : '',
    });
    if (r.ok) toast('语音配置已保存', '下次开房间生效');
    else toast(r.message || '保存失败', '', true);
  };
  clearEl.onclick = async () => {
    await api.livekitConfig({ url: '', apiKey: '', apiSecret: '' });
    urlEl.value = '';
    const keyEl = $lk('#lk-key');
    const secretEl = $lk('#lk-secret');
    const msgEl = $lk('#lk-msg');
    if (keyEl) keyEl.value = '';
    if (secretEl) secretEl.value = '';
    if (msgEl) msgEl.textContent = '已清除，房间将没有语音。';
    toast('语音配置已清除');
  };
}

/* ================= 积分商城 ================= */

const SHOP_ICONS = ['🎮', '📺', '🍫', '☕', '🎁', '🏀', '🎵', '😴'];

/* 阿刺强化态补给（与 src/aci-core.js SUPPLIES 的 id/points 口径一致）——在积分商城兑换 */
const ACI_SUPPLY_CATALOG = [
  { id: 'deepAnalysis', name: '深度分析', icon: '🔍', points: 30, desc: '历史挖掘、趋势报告' },
  { id: 'replyForMe',   name: '代回消息', icon: '💬', points: 50, desc: '好友区/军团代拟回复' },
  { id: 'pkTactics',    name: 'PK 战术建议', icon: '⚔️', points: 30, desc: '针对对手的策略' },
  { id: 'defyGuard',    name: '抗命担保', icon: '🛡️', points: 80, desc: '替你扛一次后果' },
  { id: 'forceReview',  name: '强制复盘', icon: '📋', points: 20, desc: '低完成率时弹窗复盘' },
];

function ticketLeft() {
  const until = state.guard?.allowUntil || 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 60000));
}

function renderShopPanel() {
  const shop = state.shop || { items: [], history: [] };
  const points = state.profile.points || 0;
  const left = ticketLeft();
  const items = shop.items
    .map(
      (it) => `
      <div class="shop-item ${points < it.cost ? 'locked' : ''}">
        <div class="si-icon">${it.icon}</div>
        <div class="si-info">
          <div class="st">${esc(it.name)}${it.type === 'ticket' ? `<span class="tag">灰名单放行 ${it.minutes} 分钟</span>` : ''}</div>
          <div class="sd">消耗 <b>${it.cost}</b> 积分</div>
        </div>
        <button class="btn small ${points < it.cost ? 'ghost' : ''}" data-redeem="${it.id}" ${points < it.cost ? 'disabled' : ''}>兑换</button>
        ${it.custom ? `<button class="icon-btn" data-shopdel="${it.id}" title="删除">✕</button>` : ''}
      </div>`
    )
    .join('');

  const history = (shop.history || [])
    .slice(0, 8)
    .map(
      (h) => `
      <div class="shop-hist">
        <span>${h.icon} ${esc(h.name)}</span>
        <span class="cost">-${h.cost} 分</span>
      </div>`
    )
    .join('');

  const pen = state.penalty || { key: 'ok' };
  const rescue = state.rescue;
  const credit = state.credit || {};
  const penHtml =
    pen.key === 'ok'
      ? ''
      : `<div class="pen-banner ${pen.key}">
          <div class="pen-t">${pen.label}：积分 ${state.profile.points} · 兑换规则</div>
          <div class="pen-b">${
            pen.key === 'light'
              ? `还能换 ¥${pen.cheapMax} 以内的低价奖励，但价格是平时的 ${pen.mult} 倍。`
              : pen.key === 'mid'
                ? '只能先领「救赎券」：完成 5 个微目标后解锁一次兑换。'
                : '兑换全部锁定。先打卡把积分拉回 -30 以上，一档一档回来。'
          }</div>
          ${pen.key === 'mid'
            ? rescue && !rescue.usedAt
              ? `<div class="pen-x">救赎挑战进度 ${rescue.done}/${rescue.need}${rescue.unlocked ? ' · 已解锁，可用一次' : ''}</div>`
              : '<button class="btn small" id="rescue-start">领取救赎券挑战</button>'
            : ''}
        </div>`;
  const rep = credit.rep || {};
  const pil = credit.pillars || { honest: 0, ally: 0, growth: 0 };
  const led = credit.ledger || [];
  const sc = Number(credit.score == null ? 100 : credit.score);
  const tierName = sc >= 120 ? '可信' : sc >= 100 ? '良好' : sc >= 80 ? '普通' : '受限';
  const cnt = (o, k1, k2) => `${(o && o[k1]) || 0} / ${(o && o[k2]) || 0}`;
  const creditHtml = `
    <div class="panel credit-panel">
      <h3>🛡 信誉分（与借分共用一套分 · 0~160）</h3>
      <div class="credit-grid">
        <div><b>${sc}</b><span>信誉分 · ${tierName}</span></div>
        <div><b>${credit.limit ?? 80}</b><span>可借额度</span></div>
        <div><b>${Math.round((credit.rate ?? 0.2) * 100)}%</b><span>还款期效率折扣</span></div>
      </div>
      ${
        window.PQCreditPriv
          ? `<div class="sd" style="margin:2px 0 8px">
              等级 <b>${PQCreditPriv.levelOf(sc).key || '—'} ${esc(PQCreditPriv.levelOf(sc).name)}</b>
              · 可借额度按等级给（受限 30 / 基础 50 / 社交 80 / 荣耀 120）
              · 三档特权清单在「成就」页
             </div>`
          : ''
      }
      <div class="sd" style="margin:2px 0 10px">
        三支柱（近 30 天）：<b>诚实度 ${pil.honest > 0 ? '+' : ''}${pil.honest}</b> ·
        <b>联盟贡献 ${pil.ally > 0 ? '+' : ''}${pil.ally}</b> · <b>成长 ${pil.growth > 0 ? '+' : ''}${pil.growth}</b>
        ${credit.jailed ? ' · ⛓ <b>失信期</b>' : ''}
      </div>
      <div class="rep-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px">
        <div class="rep-card" style="padding:8px 10px;border:1px solid var(--line);border-radius:10px">
          <div style="font-size:11px;color:var(--text-3)">翻案准确率</div>
          <div><b>${cnt(rep.flips, 'ok', 'bad')}</b> <span class="chat-tip">核实 / 被推翻</span></div>
        </div>
        <div class="rep-card" style="padding:8px 10px;border:1px solid var(--line);border-radius:10px">
          <div style="font-size:11px;color:var(--text-3)">举报有效度</div>
          <div><b>${cnt(rep.reports, 'ok', 'bad')}</b> <span class="chat-tip">属实 / 恶意</span></div>
        </div>
        <div class="rep-card" style="padding:8px 10px;border:1px solid var(--line);border-radius:10px">
          <div style="font-size:11px;color:var(--text-3)">贷款守约</div>
          <div><b>${cnt(rep.loans, 'ok', 'bad')}</b> <span class="chat-tip">守约 / 逾期</span></div>
        </div>
        <div class="rep-card" style="padding:8px 10px;border:1px solid var(--line);border-radius:10px">
          <div style="font-size:11px;color:var(--text-3)">助人被确认</div>
          <div><b>${(rep.help && rep.help.ok) || 0}</b> <span class="chat-tip">次</span></div>
        </div>
        <div class="rep-card" style="padding:8px 10px;border:1px solid var(--line);border-radius:10px">
          <div style="font-size:11px;color:var(--text-3)">联机稳定</div>
          <div><b>${(rep.online && rep.online.ok) || 0}</b> <span class="chat-tip">次 · 挂机 ${(rep.online && rep.online.bad) || 0}</span></div>
        </div>
        <div class="rep-card" style="padding:8px 10px;border:1px solid var(--line);border-radius:10px">
          <div style="font-size:11px;color:var(--text-3)">成长加分</div>
          <div><b>${(rep.growth && rep.growth.ok) || 0}</b> <span class="chat-tip">次全勤/纪录</span></div>
        </div>
      </div>
      ${
        led.length
          ? `<div class="sd" style="line-height:1.9;max-height:110px;overflow:auto;border-top:1px dashed var(--line);padding-top:8px">
              最近账本：${led
                .slice(0, 8)
                .map((e) => `${new Date(e.at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} <b style="color:${e.delta > 0 ? '#2a8f53' : '#d43b40'}">${e.delta > 0 ? '+' : ''}${e.delta}</b> ${esc(String(e.note || '').slice(0, 18))}`)
                .join('<br/>')}
             </div>`
          : ''
      }
      ${
        credit.loan && !credit.loan.repaidAt
          ? `<div class="credit-loan">
              <div>已借 <b>${credit.loan.amount}</b> 分 · ${credit.loan.due} 前还清（还剩 ${credit.dueIn} 天）</div>
              <div>进度：赚回 ${Math.min(credit.loan.earned, credit.loan.amount)}/${credit.loan.amount} 分 · 偿债任务 ${credit.loan.taskDone}/${credit.loan.taskNeed} 天全勤</div>
              <div class="credit-warn">还款期内每笔打卡积分按 ${Math.round((credit.rate ?? 0.2) * 100)}% 折扣计入效率损失。</div>
            </div>`
          : credit.cushion === false
            ? `<div class="credit-warn" style="margin-top:8px">🔒 借分只在强制模式下开放 —— 先去「守护」页打开强制模式。没开就说明这一局你还不需要缓冲垫，分自己挣。</div>`
            : `<div class="credit-act">
              <button class="btn small" id="credit-borrow">借 ${credit.limit ?? 80} 分</button>
              <span class="sd">代价：7 天内效率 -${Math.round((credit.rate ?? 0.2) * 100)}%，并完成 3 天全勤。按时还清信用 +10、额度翻倍。</span>
            </div>`
      }
      ${
        Date.now() < (credit.blockUntil || 0)
          ? `<div class="credit-warn" style="margin-top:8px">⚠️ 失信期至 ${new Date(credit.blockUntil).toLocaleDateString('zh-CN')}，这段时间不能借分</div>`
          : ''
      }
    </div>`;

  return `
    <div class="panel shop-panel">
      <h3>积分商城</h3>
      ${penHtml}
      ${
        left > 0
          ? `<div class="shop-ticket">🎟️ 娱乐券生效中：灰名单应用已放行 <b>${left}</b> 分钟（黑名单仍强制关闭）</div>`
          : ''
      }
      <div class="shop-balance">
        <div class="v">${points}</div>
        <div class="t">可用积分</div>
      </div>
      <div class="shop-items">${items || '<div class="sd">暂无商品</div>'}</div>
      <div class="aci-supply-shop" style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px">
        <div class="st" style="margin-bottom:6px">🌵 阿刺强化态补给 <span class="sd">（兑换后阿刺记下这项能力；它状态好时也会自己启动，消耗它的能量，每周最多 3 次）</span></div>
        <div class="shop-items">${ACI_SUPPLY_CATALOG.map((s) => `
          <div class="shop-item ${points < s.points ? 'locked' : ''}">
            <div class="si-icon">${s.icon}</div>
            <div class="si-info">
              <div class="st">${esc(s.name)} <span class="sd">${esc(s.desc)}</span></div>
              <div class="sd">消耗 <b>${s.points}</b> 积分</div>
            </div>
            <button class="btn small ${points < s.points ? 'ghost' : ''}" data-supply-redeem="${s.id}" ${points < s.points ? 'disabled' : ''}>兑换</button>
          </div>`).join('')}</div>
      </div>
      <div class="shop-add">
        <input class="input" id="shop-name" placeholder="奖励名称，如：奶茶一杯" maxlength="24" />
        <select class="select" id="shop-icon">${SHOP_ICONS.map((i) => `<option value="${i}">${i}</option>`).join('')}</select>
        <input class="input num" id="shop-cost" type="number" min="10" max="5000" value="50" title="所需积分：普通奖励至少 10 分，娱乐券至少 50 分" />
        <select class="select" id="shop-type">
          <option value="plain">普通奖励</option>
          <option value="ticket">娱乐券（放行灰名单）</option>
        </select>
        <select class="select" id="shop-minutes" style="display:none">
          ${[15, 30, 60, 120].map((m) => `<option value="${m}">${m} 分钟</option>`).join('')}
        </select>
        <button class="btn small" id="shop-add">添加</button>
      </div>
      <div class="sd" style="margin-top:6px">🔒 设置奖励需守护密码 · 普通奖励 ≥ 10 积分 · 娱乐券（放行灰名单）≥ 50 积分</div>
      ${history ? `<div class="shop-history"><div class="sd" style="margin-bottom:6px">兑换记录</div>${history}</div>` : ''}
    </div>
    ${creditHtml}
  `;
}

function bindShopPanel() {
  const rescueBtn = $('#rescue-start');
  if (rescueBtn) {
    rescueBtn.onclick = async () => {
      const r = await api.shopRescueStart();
      if (!r || !r.ok) return toast(r?.message || '暂时不能领', '', true);
      toast('救赎券已领', '完成 5 个微目标就解锁一次兑换');
      api.getState().then((s) => ((state = s), render()));
    };
  }
  const borrowBtn = $('#credit-borrow');
  if (borrowBtn) {
    borrowBtn.onclick = async () => {
      const amount = Number(borrowBtn.textContent.replace(/[^\d]/g, '')) || 50;
      const ok = await confirmDialog(
        `借 ${amount} 分？`,
        `借到的分立刻可用。代价：7 天内每笔打卡的效率损失 ${Math.round(((state.credit && state.credit.rate) || 0.2) * 100)}%，并要完成 3 天全勤；逾期会扣信用分、降额度，30 天内不能再借。`
      );
      if (!ok) return;
      const r = await api.creditBorrow(amount);
      if (!r || !r.ok) return toast(r?.message || '借款失败', '', true);
      toast(`已借到 ${amount} 分`, `还款期到 ${r.loan.due}，别忘了`);
      api.getState().then((s) => ((state = s), render()));
    };
  }
  const typeSel = $('#shop-type');
  if (!typeSel) return;
  typeSel.onchange = () => {
    $('#shop-minutes').style.display = typeSel.value === 'ticket' ? '' : 'none';
    // 娱乐券至少 50 分，普通奖励至少 10 分：切换类型时同步最小值
    const min = typeSel.value === 'ticket' ? 50 : 10;
    const cost = $('#shop-cost');
    cost.min = String(min);
    if (Number(cost.value) < min) cost.value = String(min);
  };
  $('#shop-add').onclick = async () => {
    const name = $('#shop-name').value.trim();
    if (!name) {
      toast('请填写奖励名称', '', true);
      $('#shop-name').focus();
      return;
    }
    const payload = {
      name,
      icon: $('#shop-icon').value,
      cost: Number($('#shop-cost').value) || 50,
      type: typeSel.value,
      minutes: Number($('#shop-minutes').value) || 30,
    };
    let r = await api.shopAddItem(payload);
    if (r && r.needPassword) {
      const pw = await askPassword('设置奖励需验证守护密码');
      if (!pw) return toast('已取消', '', true);
      r = await api.shopAddItem({ ...payload, password: pw });
      if (r && r.needPassword) return toast('密码不对', '奖励未添加', true);
    }
    if (r && r.ok) toast('商品已上架', name);
    else toast((r && r.message) || '添加失败', '', true);
  };
  $$('[data-redeem]').forEach((el) => {
    el.onclick = async () => {
      const r = await api.shopRedeem(el.dataset.redeem);
      if (r.ok) toast('兑换成功 🎉', r.message);
      else toast(r.message || '兑换失败', '', true);
    };
  });
  /* 阿刺强化态补给兑换：走 aciAction，扣积分由主进程统一处理 */
  $$('[data-supply-redeem]').forEach((el) => {
    el.onclick = async () => {
      if (!api || typeof api.aciAction !== 'function') return toast('此功能需桌面版', '', true);
      const r = await api.aciAction('redeemSupply', { supplyId: el.dataset.supplyRedeem });
      if (r && r.ok) toast('补给已兑换 🌵', r.message);
      else toast((r && r.message) || '兑换失败', '', true);
      if (r && r.ok) api.getState().then((s) => ((state = s), render()));
    };
  });
  $$('[data-shopdel]').forEach((el) => {
    el.onclick = async () => {
      let r = await api.shopDeleteItem(el.dataset.shopdel);
      if (r && r.needPassword) {
        const pw = await askPassword('删除奖励需验证守护密码');
        if (!pw) return toast('已取消', '', true);
        r = await api.shopDeleteItem({ id: el.dataset.shopdel, password: pw });
        if (r && r.needPassword) return toast('密码不对', '奖励未删除', true);
      }
      if (r && r.ok) toast('商品已下架', '');
      else toast((r && r.message) || '删除失败', '', true);
    };
  });
}

/* ================= 军团 ================= */

function lgAgo(t) {
  if (!t) return '还没同步过';
  const d = Date.now() - t;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.round(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.round(d / 3600e3) + ' 小时前';
  return Math.round(d / 86400e3) + ' 天前';
}

function lgLeft(ms) {
  if (!ms) return '随时';
  const m = Math.ceil(ms / 60e3);
  if (m <= 1) return '不到 1 分钟';
  if (m < 60) return m + ' 分钟后';
  const h = Math.round(m / 60);
  return h + ' 小时后';
}

function lgWeekBars(agg) {
  const rows = (agg && Array.isArray(agg.weeks) ? agg.weeks : []).slice(-7);
  if (!rows.length) return '';
  const label = ['一', '二', '三', '四', '五', '六', '日'];
  return `
    <div class="lg-bars">
      ${rows
        .map((r) => {
          const d = new Date(r.day + 'T00:00:00');
          const wd = (d.getDay() + 6) % 7;
          return `<div class="lg-bar-cell" title="${esc(r.day)}">
            <div class="lg-bar lg-lv${r.level}"></div>
            <span>${label[wd]}</span>
          </div>`;
        })
        .join('')}
    </div>`;
}

/* 网络拓扑：房主只跑信令，成员之间直连。这里把「谁跟谁怎么连」摊开给用户看 */
function lgMeshHTML() {
  const M = window.PQLegionMesh;
  if (!M || typeof M.info !== 'function') return '';
  const i = M.info();
  if (!i.mounted) return '';
  const roleTxt = i.role === 'host' ? '房主' : i.role === 'deputy' ? '副主（接管信令）' : '成员';
  const hostTxt = i.host === i.selfUid ? '本机' : i.host ? '成员 ' + esc(i.host.slice(0, 6)) : '未确定';
  const rows = i.peers.length
    ? i.peers
        .map((p) => {
          const link =
            p.state === 'direct' ? '<span class="lg-chip">直连</span>'
              : p.state === 'overlay' ? '<span class="lg-chip">组网</span>'
                : p.state === 'relay' ? '<span class="lg-chip warm">中继</span>'
                  : p.state === 'unstable' ? '<span class="lg-chip">链路不稳</span>'
                    : '<span class="lg-chip">未连通</span>';
          return `<div class="lg-peer">
            <span class="lg-peer-n">${esc(p.alias || p.uid.slice(0, 6))}</span>
            <span class="lg-peer-r">${esc(p.tier)}</span>
            ${link}
            <span class="lg-peer-k">${p.encrypted ? '🔒 已加密' : '…协商中'}</span>
          </div>`;
        })
        .join('')
    : '<div class="lg-empty">还没有其他成员连进来。</div>';
  const mins = Math.max(0, Math.round(i.rotateInMs / 60000));
  return `
    <div class="panel">
      <h3>网络结构</h3>
      <div class="lg-state"><span class="lg-dot ${i.hostAlive ? 'on' : 'off'}"></span>
        <span>${esc(roleTxt)} · 信令节点：${hostTxt} · ${esc(i.topoText)}</span>
      </div>
      <div class="sd" style="margin:6px 0 10px;opacity:.8">
        房主只转发信令（谁在房里、谁跟谁连），聊天与摘要走成员之间的直连，不过房主。
        每一对成员各自协商一把密钥，房主看不到；${mins} 分钟后自动轮换。
      </div>
      ${rows}
      <div class="lg-hint">
        打洞失败时先自动升级到 TURN 中继；仍然连不上，说明双方 NAT 太严，
        建议装 Tailscale / ZeroTier 组一张虚拟局域网，再连就会显示「组网」。
      </div>
    </div>`;
}

/* ---------------- 军团 PK（跨军团出操率对垒） ----------------
 * 数据来自主进程的自动任务：军团主往免费文件托管平台的布告栏上报聚合数字，
 * 成员只读。对手永远只是一个代号。 */

let pkCache = null; // 最近一次 PK 快照
let pkAt = 0; // 上次拉取时间（节流，防渲染循环）
let pkDuel = null; // 对决动画数据：banner 跃迁时设置，渲染一次后清空

function pkRefresh() {
  if (!(window.api && typeof window.api.legionPkStatus === 'function')) return;
  if (Date.now() - pkAt < 60e3) return;
  pkAt = Date.now();
  window.api
    .legionPkStatus()
    .then((p) => {
      const prevKey = pkCache && pkCache.banner ? pkCache.banner.kind + '|' + pkCache.banner.until : '';
      const nextKey = p && p.banner ? p.banner.kind + '|' + p.banner.until : '';
      /* 结算横幅新出现 → 播放一次对决动画（同一场不重复播） */
      if (nextKey && nextKey !== prevKey) {
        pkDuel = {
          kind: p.banner.kind,
          mine: (p.my && p.my.rate7) || 0,
          theirs: (p.match && p.match.opponent && p.match.opponent.rate7) || 0,
          opponent: (p.match && p.match.opponent && p.match.opponent.code) || '对手',
        };
        /* 阿刺在结算这一刻也来一句 */
        if (window.PQBuddy && window.PQBuddy.say) {
          const lines = {
            win: '这局赢了。别飘，下周期望值只会更高。',
            lose: '输了。安慰奖也是奖——下把把出操率拉回来。',
            draw: '平局。旗鼓相当，说得好像多体面似的。',
          };
          window.PQBuddy.say(lines[p.banner.kind] || '打完了。', p.banner.kind === 'win' ? 'happy' : 'smirk');
        }
      }
      pkCache = p || null;
      if (currentView === 'legion') render(false);
    })
    .catch(() => {});
}

function pkMatchText(p) {
  const m = p && p.match;
  if (!m) return '';
  switch (m.state) {
    case 'active':
      return m.opponent ? `比赛中 · 对手「军团 ${esc(m.opponent.code)}」` : '比赛中';
    case 'bye':
      return '这周轮空 —— 报名人数是单数，没有分到对手，不奖不罚。';
    case 'done':
      return `本周已结算 · 战绩 ${p.record.w} 胜 ${p.record.d} 平 ${p.record.l} 负`;
    case 'idle':
    default:
      return p.canManage ? '还没报名。报名后每周一自动匹配，不可拒绝，也不能手动挑对手。' : 'PK 由军团主的电脑报名。';
  }
}

function pkBannerText(b) {
  switch (b.kind) {
    case 'win':
      return '🏆 胜利旗帜已升起（24 小时）—— 全团下周积分效率 +5%。';
    case 'lose':
      return '⚔ 再接再厉（24 小时）—— 钢铁意志徽章已发放，下周积分效率 +3% 安慰奖。';
    case 'draw':
      return '🤝 旗鼓相当 —— 差距不到每天 1%，双方各得一枚徽章，输赢都不痛不痒。';
    default:
      return '';
  }
}

function pkPanelHtml(p, L) {
  if (!(window.api && typeof window.api.legionPkStatus === 'function')) {
    return '<div class="lg-empty">军团 PK 需要电脑版：后台要自动读写布告栏，网页版没有这个能力。</div>';
  }
  if (!p) return '<div class="lg-empty">PK 状态加载中…（第一次要连一次布告栏，稍等几秒）</div>';
  if (p.frozen) {
    return `<div class="lg-warn">PK 资格冻结中：PK 期间军团内部举报异常，本场自动判负，两周后自动解冻。</div>`;
  }
  const m = p.match || {};
  const opp = m.opponent;
  const stateTxt = pkMatchText(p);
  const myTxt = p.my && p.my.size ? `我方：${p.my.size} 人 · 近 7 天平均出操率 ${p.my.rate7}%` : '我方：还没有聚合数据（等军团聚起来）';
  const oppTxt =
    m.state === 'active' && opp
      ? `敌方：军团 ${esc(opp.code)}${opp.size ? ` · ${opp.size} 人` : ''}${opp.rate7 != null ? ` · 平均出操率 ${opp.rate7}%` : ''}<span class="lg-you-note">对面具体是谁，一个名字都看不到，赛后也无法清算。</span>`
      : '';
  const reports = p.reports && p.reports.length
    ? `<ul class="lg-log">${p.reports
        .map((r) => `<li><span class="lg-log-t">${esc(r.day.slice(5))}</span>${esc(r.text)}</li>`)
        .join('')}</ul>`
    : m.state === 'active'
      ? '<div class="lg-empty">每天晚上会有一条匿名战报，只说我方和敌方。</div>'
      : '';
  const days = p.myDays && p.myDays.length
    ? `<div class="lg-hint">本周我方出操率：${p.myDays.map((d) => `${d.day.slice(5)} ${d.pct}%`).join(' · ')}</div>`
    : '';
  const badgeTxt = p.badges && p.badges.length
    ? `<div class="lg-chips">${p.badges.map((b) => `<span class="lg-chip warm">🎖 ${esc(b)}</span>`).join('')}</div>`
    : '';
  const buffTxt = p.buff && p.buff.pct
    ? `<div class="lg-hint">下周（${esc(p.buff.from)} 起）全团打卡积分效率 +${p.buff.pct}%，自动生效。</div>`
    : '';
  const bannerTxt = p.banner ? `<div class="lg-you">${esc(pkBannerText(p.banner))}</div>` : '';
  /* 对决动画：结算横幅新出现时播放一次（含双方出操率与结果） */
  let duelHtml = '';
  if (pkDuel) {
    const d = pkDuel;
    const resultLabel = { win: '🏆 胜利', lose: '⚔ 失败', draw: '🤝 平局' }[d.kind] || '对决结束';
    const emoji = d.kind === 'win' ? '🌵🏆' : d.kind === 'lose' ? '🌵💧' : '🌵🤝';
    duelHtml = `<div class="duel-stage">
      <div class="duel-slash"></div>
      <div class="duel-side"><span class="duel-emoji">🌵</span><span class="duel-name">我方军团</span><span class="duel-power">${Number(d.mine) || 0}%</span></div>
      <div class="duel-vs">VS</div>
      <div class="duel-side them"><span class="duel-emoji">🛡️</span><span class="duel-name">军团 ${esc(String(d.opponent).slice(0, 8))}</span><span class="duel-power">${Number(d.theirs) || 0}%</span></div>
    </div>
    <div class="duel-result ${esc(d.kind)}">${resultLabel} · ${emoji}</div>`;
    pkDuel = null; // 只播一次
  }
  const joinBtn = p.canManage && (m.state === 'idle' || m.state === 'done')
    ? '<div class="lg-actions"><button class="btn" id="lg-pk-join">报名参赛（自动匹配）</button></div>'
    : '';
  return `
    ${duelHtml}
    ${bannerTxt}
    <div class="lg-mood">${stateTxt}</div>
    <div class="lg-hint">${myTxt}</div>
    ${oppTxt}
    ${days}
    ${reports}
    ${joinBtn}
    ${buffTxt}
    ${badgeTxt}
    ${p.err ? `<div class="lg-err">${esc(p.err)}（会自动重试）</div>` : ''}
    <div class="lg-note">只比一个指标：出操率（当日打卡人数 ÷ 总人数）—— 比「有多少人在坚持」，不比谁更卷。周一匹配、周日结算，差距折合每天不足 1% 算平局。赛季（每季度）结束时 PK 记录清零，收集的徽章保留。上传到布告栏的只有军团码、人数和每日出操率，没有名字、没有计划、没有积分。</div>`;
}

function renderLegion() {
  const L = window.PQLegion ? PQLegion.info() : { available: false, joined: false };
  const agg = L.agg || null;
  const head = `
    <div class="view-head">
      <div class="view-title">军团</div>
      <div class="view-sub">同步的只有状态，不同步明细</div>
    </div>`;

  /* ---------- 异地成员：已生成回执码，等房主粘贴 ---------- */
  if (L.pendingJoin) {
    const text = window.__lgReply || '';
    $('#view').innerHTML = `
      ${head}
      <div class="panel">
        <h3>等房主粘贴回执码</h3>
        <p class="lg-lead">把下面这段发给房主，他粘上之后你们就连上了。连上之后才会开始同步，现在一个字节都还没发。</p>
        <div class="lg-code">${esc(text || '（回执码生成中…）')}</div>
        <div class="lg-actions">
          <button class="btn" id="lg-copy-reply">复制回执码</button>
          <button class="btn ghost" id="lg-cancel-wait">取消</button>
        </div>
        <div class="lg-hint">异地连接是点对点的，只有双方软件都开着才保持连接；关掉之后要重新配对一次。</div>
      </div>`;
    const c = $('#lg-copy-reply');
    if (c)
      c.onclick = () => {
        copyText(text);
        toast('已复制', '发给房主，让他粘贴');
      };
    const x = $('#lg-cancel-wait');
    if (x)
      x.onclick = () => {
        window.__lgReply = '';
        PQLegion.leave();
        render(false);
      };
    return;
  }

  /* ---------- 未加入 ---------- */
  if (!L.joined) {
    const disabled = L.available ? '' : 'disabled';
    $('#view').innerHTML = `
      ${head}
      <div class="panel">
        <h3>先看清单，再决定要不要加入</h3>
        <p class="lg-lead">军团不是排行榜。它只在你和几个同路人之间，每隔几小时交换一次「今天什么状态」——房主收到的是四态，不是你的记录。</p>
        <div class="lg-cols">
          <div class="lg-col">
            <div class="lg-col-t">同步的只有四种状态</div>
            <ul>
              <li>今日已打卡 ✅</li>
              <li>今日未打卡</li>
              <li>强制模式中</li>
              <li>负分挣扎中</li>
            </ul>
          </div>
          <div class="lg-col no">
            <div class="lg-col-t">永远不同步</div>
            <ul>
              <li>计划内容、备注、日记</li>
              <li>具体时长、完成率</li>
              <li>积分余额、契约金额</li>
              <li>摄像头画面、屏幕内容</li>
              <li>你的真名（昵称可留空）</li>
            </ul>
          </div>
        </div>
        <div class="lg-note">没加入军团时，一个包都不会发出去。加入后也可以随时暂停或退出，退出即停一切外发。</div>
      </div>

      ${discPanelHTML()}

      <div class="panel">
        <div class="lg-form-t" style="margin-top:0">同一个 WiFi</div>
        <div class="lg-actions">
          <button class="btn" id="lg-create-lan" ${disabled}>创建军团</button>
          <button class="btn ghost" id="lg-join-lan" ${disabled}>用军团码加入</button>
        </div>

        <div class="lg-form-t" style="margin-top:18px">不同网络（异地）</div>
        <div class="lg-actions">
          <button class="btn" id="lg-create-p2p" ${L.p2p ? '' : 'disabled'}>创建军团</button>
          <button class="btn ghost" id="lg-join-p2p" ${L.p2p ? '' : 'disabled'}>粘贴邀请码加入</button>
        </div>
        <div class="lg-hint">异地用的是自习房「异地联机」同一套点对点技术：用微信互发一段连接码配对，数据直连，<b>不经过任何服务器</b>。需要双方软件都开着。</div>
        ${L.p2p ? '' : '<div class="lg-warn">这台设备没有异地通道能力（网页版不支持，手机版暂只支持同一个 WiFi）。</div>'}
        ${L.available ? '' : '<div class="lg-warn">这台设备没有局域网同步能力：电脑版可以创建或加入，手机版可以加入，网页版不支持。</div>'}

        <div class="lg-form" id="lg-lan-form" hidden>
          <div class="lg-form-t">加入别人的军团（同一个 WiFi）</div>
          <div class="lg-fields">
            <input class="input" id="lg-ip" placeholder="房主 IP，如 192.168.1.5" maxlength="40" />
            <input class="input" id="lg-code" placeholder="军团码（4 位）" maxlength="8" />
            <input class="input" id="lg-alias" placeholder="昵称（留空 = 匿名成员）" maxlength="12" />
          </div>
          <div class="lg-actions">
            <button class="btn" id="lg-join-go">加入</button>
            <button class="btn ghost" id="lg-cancel-lan">取消</button>
          </div>
          <div class="lg-hint">房主那台电脑上的 PlanQuest 需要开着（托盘里也算）。</div>
        </div>

        <div class="lg-form" id="lg-p2p-create" hidden>
          <div class="lg-form-t">异地创建（我当房主）</div>
          <div class="lg-fields">
            <input class="input" id="lg-alias2" placeholder="你的昵称（留空 = 匿名成员）" maxlength="12" />
          </div>
          <div class="lg-actions">
            <button class="btn" id="lg-create-go">创建</button>
            <button class="btn ghost" id="lg-cancel-p2p">取消</button>
          </div>
          <div class="lg-hint">创建后生成一段邀请码，发给同路人；他把回执码发回来，你粘贴后就连上了。</div>
        </div>

        <div class="lg-form" id="lg-p2p-join" hidden>
          <div class="lg-form-t">异地加入（我是成员）</div>
          <div class="lg-fields">
            <input class="input" id="lg-invite" placeholder="粘贴房主发来的邀请码" maxlength="4000" />
            <input class="input" id="lg-alias3" placeholder="昵称（留空 = 匿名成员）" maxlength="12" />
          </div>
          <div class="lg-actions">
            <button class="btn" id="lg-accept-go">生成回执码</button>
            <button class="btn ghost" id="lg-cancel-join2">取消</button>
          </div>
        </div>
      </div>`;
    bindLegionIntro();
    return;
  }

  /* ---------- 已加入 ---------- */
  const roleText = L.role === 'host' ? '房主' : '成员';
  const netText = L.net === 'p2p' ? '异地点对点' : '局域网';
  const dot = L.paused ? 'pause' : L.online ? 'on' : 'off';
  const stateText = L.paused ? '已暂停同步' : L.online ? '在线' : '未连上（到点会重试）';
  const c = agg && agg.challenge;
  const pct = c && c.target ? Math.min(100, Math.round((c.done / c.target) * 100)) : 0;
  const myPts = (state && state.profile && Number(state.profile.points)) || 0;

  $('#view').innerHTML = `
    ${head}

    <div class="panel">
      <h3>同步</h3>
      <div class="lg-state">
        <span class="lg-dot ${dot}"></span>
        <span>${roleText} · ${netText} · 军团码 <b>${esc(L.code || '')}</b> · ${stateText}</span>
      </div>
      ${L.role === 'host' && L.net === 'lan' ? `<div class="lg-share">把这两行发给同路人：<br><b>${esc(L.ip || '')}</b> · 军团码 <b>${esc(L.code || '')}</b></div>` : ''}
      ${L.role === 'host' && L.net === 'p2p' ? `<div class="lg-share">异地军团：点下面的「邀请一位成员」生成邀请码，用微信发给对方他自己粘贴即可。</div>` : ''}
      ${L.role === 'member' && L.net === 'p2p' ? `<div class="lg-share">异地成员：连接断开后（关过软件），点「重新配对」让房主再发一次邀请码。</div>` : ''}

      <div class="set-row">
        <div class="set-info">
          <div class="st">同步间隔</div>
          <div class="sd">每隔这么久上报一次状态。越短越勤，但也更费电。</div>
        </div>
        <select class="select" id="lg-interval">
          ${[2, 4, 8, 12]
            .map((h) => `<option value="${h}" ${L.intervalH === h ? 'selected' : ''}>${h} 小时</option>`)
            .join('')}
        </select>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="st">暂停同步</div>
          <div class="sd">暂停后定时器照常走，但不会建立连接、不会发任何数据；恢复后自动补一次。</div>
        </div>
        <div class="switch ${L.paused ? 'on' : ''}" id="lg-pause"></div>
      </div>

      <div class="lg-actions">
        <button class="btn" id="lg-sync" ${L.busy ? 'disabled' : ''}>${L.busy ? '同步中…' : '立即同步'}</button>
        ${L.role === 'host' && L.net === 'p2p' ? '<button class="btn ghost" id="lg-invite">邀请一位成员</button>' : ''}
        ${L.role === 'member' && L.net === 'p2p' ? '<button class="btn ghost" id="lg-repair">重新配对</button>' : ''}
        <button class="btn ghost" id="lg-leave">退出军团</button>
      </div>
      <div class="lg-note">
        上次同步 ${lgAgo(L.lastSyncAt)} · ${L.paused ? '已暂停' : '下次 ' + lgLeft(L.leftMs)}
        ${L.err ? `<span class="lg-err">· ${esc(L.err)}</span>` : ''}
      </div>

      ${
        L.role === 'host' && L.net === 'p2p'
          ? `<div class="lg-form" id="lg-invite-box" hidden>
              <div class="lg-form-t">① 让新成员粘贴这段</div>
              <div class="lg-code" id="lg-invite-text">生成中…</div>
              <div class="lg-actions"><button class="btn ghost" id="lg-copy-invite">复制邀请码</button></div>
              <div class="lg-form-t" style="margin-top:14px">② 把他发回来的回执码粘在这里</div>
              <div class="lg-fields"><input class="input" id="lg-reply-in" placeholder="粘贴回执码" maxlength="4000" /></div>
              <div class="lg-actions"><button class="btn" id="lg-reply-go">完成配对</button></div>
            </div>`
          : ''
      }
    </div>

    ${lgMeshHTML()}

    ${discPanelHTML()}

    <div class="panel" id="lg-gov">
      <h3>团内治理</h3>
      <div class="sd">正在读成员目录…</div>
    </div>

    ${lgChatHTML()}

    <div class="panel">
      <h3>军团士气</h3>
      ${
        agg
          ? `
        <div class="lg-heat">
          <div class="lg-heat-top"><span>军团热度</span><b>${L.heat}</b></div>
          <div class="lg-heat-bar"><div class="lg-heat-fill" style="width:${L.heat}%"></div></div>
        </div>
        <div class="lg-morale">
          <div class="lg-morale-cell"><div class="lg-morale-n">${['—', '零星', '过半', '全员'][agg.rate || 0]}</div><div class="lg-morale-t">今天的出操率</div></div>
          <div class="lg-morale-cell"><div class="lg-morale-n">${agg.streakWeeks ? agg.streakWeeks + ' 周' : '—'}</div><div class="lg-morale-t">连续达标周数</div></div>
          <div class="lg-morale-cell"><div class="lg-morale-n">${agg.rescue || 0}</div><div class="lg-morale-t">救援值（累计点灯）</div></div>
        </div>
        <div class="lg-mood">${esc(PQLegion.moodText(agg))}</div>
        <div class="lg-chips">
          <span class="lg-chip">今天 ${agg.today.checked} 人已打卡 · ${agg.today.unchecked} 人未打卡</span>
          ${agg.today.force ? `<span class="lg-chip warm">${agg.today.force} 人正在强制模式</span>` : ''}
          ${agg.today.neg ? `<span class="lg-chip">${agg.today.neg} 人正在负分挣扎</span>` : ''}
        </div>
        ${L.you ? `<div class="lg-you">你的位置 · ${posText(L.you)}<span class="lg-you-note">只有你看得见，别人看不到任何名次</span></div>` : ''}
        <div class="lg-note">士气是全团共享的，不会显示到某个人身上：没有排名、没有点名、没有个人统计表。</div>
        ${lgWeekBars(agg)}`
          : '<div class="lg-empty">还没收到过军团概况。到点自动同步一次，或点上面的「立即同步」。</div>'
      }
    </div>

    <div class="panel">
      <h3>这周一起</h3>
      ${
        c && c.target
          ? `
        <div class="lg-week">
          <div class="lg-week-lv">${c.reached ? '✅ 达成' : '⏳ 还差一点'}</div>
          <div class="lg-week-txt">${esc(PQLegion.weekText(agg))}</div>
          <div class="lg-week-bar"><div class="lg-week-fill" style="width:${pct}%"></div></div>
          <div class="lg-hint">目标：本周全团累计打卡 ${c.target} 次（人均每周 5 天）。只统计「有没有打卡」，不统计时长，也不看谁差多少。</div>
          <div class="lg-hint">只奖不罚：达标就发一枚集体徽章，次日打卡积分双倍；没凑够就当这周没发生过，不扣分、不降级、不通报。</div>
        </div>`
          : '<div class="lg-empty">还没有这周的数据。</div>'
      }
    </div>

    <div class="panel">
      <h3>军团 PK</h3>
      ${pkPanelHtml(pkCache, L)}
    </div>

    <div class="panel">
      <h3>翻车救援</h3>
      <p class="lg-lead">状态变成「负分挣扎中」的人，会在这里被匿名看见 —— 系统不知道是谁，只知道有 ${agg ? agg.today.neg || 0 : 0} 个人正在坑里。</p>
      <div class="lg-actions">
        <button class="btn" id="lg-lamp">为坑里的人点一盏灯（-5 分）</button>
        ${myPts < 0 ? '<button class="btn ghost" id="lg-claim">从救援池领一盏灯（+5 分）</button>' : ''}
      </div>
      <div class="lg-hint">点灯要自己掏 5 分，每天最多 3 盏 —— 积分不会凭空多出来。匿名互助：不记是谁点的、点给谁，只有军团「救援值」会 +1。</div>
      <div class="lg-hint">正在负分的人每天可以从救援池里领一盏（+5 分），领完池子就少一盏。没在坑里的人把这个按钮收起来。</div>
      <div class="lg-note">${agg && agg.rescue ? `军团救援池还剩 ${agg.rescue} 盏灯。` : '救援池现在是空的。'}</div>
    </div>

    <div class="panel">
      <h3>军团日志</h3>
      ${
        agg && agg.log && agg.log.length
          ? `<ul class="lg-log">${agg.log.map((it) => `<li><span class="lg-log-t">${esc(lgLogTime(it.at))}</span>${esc(lgLogText(it))}</li>`).join('')}</ul>
             <div class="lg-note">日志只记事件，不记人名。</div>`
          : '<div class="lg-empty">还没有事件。第一次同步之后这里会慢慢有东西。</div>'
      }
      <div class="set-row" style="margin-top:14px">
        <div class="set-info">
          <div class="st">熔断开关</div>
          <div class="sd">关掉自动化的集体挑战与徽章发放。不解散军团、不惩罚任何人，随时可以打开。</div>
        </div>
        <div class="switch ${L.muted ? 'on' : ''}" id="lg-mute"></div>
      </div>
    </div>`;

  bindLegionPanel(L);
  bindLegionChat(L);

  /* 军团 PK：报名按钮 + 异步刷新状态（60 秒节流） */
  pkRefresh();
  const pkJoin = $('#lg-pk-join');
  if (pkJoin)
    pkJoin.onclick = async () => {
      pkJoin.disabled = true;
      pkJoin.textContent = '报名中…';
      try {
        const r = await window.api.legionPkJoin();
        toast(r && r.ok ? '已报名' : '报名失败', (r && r.message) || '周一自动匹配对手');
      } catch (_) {
        toast('报名失败', '网络没通，稍后再试');
      }
      pkAt = 0;
      pkRefresh();
      setTimeout(() => {
        if (currentView === 'legion') render(false);
      }, 1500);
    };
}

/* 个人位置：只有本人看得见，措辞不排名次 */
function posText(pos) {
  switch (pos) {
    case 'top':
      return '军团前列';
    case 'upper':
      return '中上';
    case 'mid':
      return '中段';
    case 'lower':
      return '暂时靠后（没人知道是你）';
    default:
      return '军团里目前只有你';
  }
}

/* 复制一段文本（连接码很长，必须可靠） */
function copyText(text) {
  const t = String(text || '');
  if (!t) return;
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (_) {}
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).catch(fallback);
    else fallback();
  } catch (_) {
    fallback();
  }
}

/* 日志：只描述发生了什么，不带任何人名 */
function lgLogText(it) {
  const n = Number(it.n) || 0;
  switch (it.kind) {
    case 'challenge':
      return `集体挑战达成，${n} 人一起拿下这周的目标`;
    case 'rescue':
      return '有人点了一盏救援灯';
    case 'mute':
      return '熔断开关打开了，挑战奖励暂停';
    case 'unmute':
      return '熔断开关关掉了，恢复正常';
    default:
      return '军团有了一次变化';
  }
}

function lgLogTime(at) {
  const d = new Date(Number(at) || 0);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function bindLegionIntro() {
  const show = (id) => {
    const f = document.getElementById(id);
    if (f) f.hidden = false;
  };
  const hide = (id) => {
    const f = document.getElementById(id);
    if (f) f.hidden = true;
  };

  const on = (id, fn) => {
    const b = document.getElementById(id);
    if (b) b.onclick = fn;
  };

  on('lg-create-lan', () => {
    const alias = prompt('你的昵称（留空 = 匿名成员）', '');
    if (alias === null) return;
    PQLegion.create({ alias: (alias || '').trim(), net: 'lan', credit: creditScore() }).then((r) => {
      if (!r.ok) return toast('创建失败', r.message || '', true);
      toast('军团已建立', `军团码 ${r.code} · 把 IP 和军团码发给同路人`);
      render(false);
    });
  });

  on('lg-join-lan', () => {
    show('lg-lan-form');
    const el = $('#lg-ip');
    if (el) el.focus();
  });

  on('lg-create-p2p', () => show('lg-p2p-create'));
  on('lg-join-p2p', () => {
    show('lg-p2p-join');
    const el = $('#lg-invite');
    if (el) el.focus();
  });

  on('lg-cancel-lan', () => hide('lg-lan-form'));
  on('lg-cancel-p2p', () => hide('lg-p2p-create'));
  on('lg-cancel-join2', () => hide('lg-p2p-join'));

  on('lg-join-go', async () => {
    const btn = $('#lg-join-go');
    if (btn) btn.disabled = true;
    const ip = ($('#lg-ip')?.value || '').trim();
    const code = ($('#lg-code')?.value || '').trim();
    const alias = ($('#lg-alias')?.value || '').trim();
    const r = await PQLegion.join({ ip, code, alias });
    if (btn) btn.disabled = false;
    if (!r.ok) return toast('加入失败', r.message || '', true);
    toast('已加入军团', '到点会自动同步一次状态');
    render(false);
  });

  on('lg-create-go', async () => {
    const btn = $('#lg-create-go');
    if (btn) btn.disabled = true;
    const alias = ($('#lg-alias2')?.value || '').trim();
    const r = await PQLegion.create({ alias, net: 'p2p', credit: creditScore() });
    if (btn) btn.disabled = false;
    if (!r.ok) return toast('创建失败', r.message || '', true);
    toast('异地军团已建立', '点「邀请一位成员」生成邀请码');
    render(false);
  });

  on('lg-accept-go', async () => {
    const btn = $('#lg-accept-go');
    if (btn) btn.disabled = true;
    const invite = ($('#lg-invite')?.value || '').trim();
    const alias = ($('#lg-alias3')?.value || '').trim();
    const r = await PQLegion.joinP2P({ invite, alias });
    if (btn) btn.disabled = false;
    if (!r.ok) return toast('邀请码用不了', r.message || '', true);
    window.__lgReply = r.text || '';
    toast('回执码已生成', '发给房主，他粘贴后就能连上');
    render(false);
  });

  bindDiscPanel();
}

/* ================================================================
   军团频道
   ----------------------------------------------------------------
   军团自己的频道：不进自习房也能说话。
   规则由团长定（开关 / 宽松标准严格 / 禁言时长 / 自定义词），写在频道顶部，
   改完全员立即同步。判定用的是同一份纯函数 —— 谁被拦、为什么被拦，人人算得一样。
   ================================================================ */

let lgcUnsub = null;

function lgcTime(at) {
  const d = new Date(Number(at) || 0);
  const p = (x) => String(x).padStart(2, '0');
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function lgcLinkCard(link) {
  if (link.kind === 'room') {
    return `<div class="lgc-link"><span class="lgc-link-t">🏠 自习房 · 房间码 <b>${esc(link.code)}</b></span>
      <button class="btn small" data-room="${esc(link.ip)}|${Number(link.port) || 0}|${esc(link.code)}">进入房间</button></div>`;
  }
  if (link.kind === 'legion') {
    const raw = encodeURIComponent(JSON.stringify(link));
    return `<div class="lgc-link"><span class="lgc-link-t">🛡 军团 · ${link.net === 'p2p' ? '异地' : '同一个 WiFi'} · 军团码 <b>${esc(link.code)}</b></span>
      <button class="btn small" data-legion="${esc(raw)}">加入军团</button></div>`;
  }
  if (link.kind === 'pk') {
    const rawPk = encodeURIComponent(JSON.stringify(link));
    return `<div class="lgc-link pk-challenge-card"><span class="lgc-link-t">⚔️ PK 挑战 · 来自 <b>${esc(link.name)}</b> · 战力 ${Number(link.rate) || 0} · ${Number(link.days) || 3} 天有效</span>
      <button class="btn small" data-pk="${esc(rawPk)}">应战</button></div>`;
  }
  return '';
}

/* 正文渲染：@ 高亮 + pq:// 链接变按钮，两件事都在这里收口 */
function lgcTextHTML(text, s) {
  const lib = window.PQLegionChat;
  if (!lib) return esc(text);
  const segs = lib.splitLinks ? lib.splitLinks(text) : [{ text }];
  return segs
    .map((seg) => {
      if (seg.link) return lgcLinkCard(seg.link);
      const parts = lib.splitMentions ? lib.splitMentions(seg.text, s.roster || []) : [{ text: seg.text }];
      return parts.map((p) => (p.at ? `<span class="lgc-at">${esc(p.text)}</span>` : esc(p.text))).join('');
    })
    .join('');
}

function lgcLogHTML(s) {
  const T = window.PQLegionTier;
  const ti = window.__pqTier || null;
  if (!s.log || !s.log.length) {
    return '<div class="lgc-empty">频道是空的。说第一句话，别人到点同步时就会看到。</div>';
  }
  return s.log
    .map((m) => {
      if (!m) return '';
      if (m.sys) return `<div class="lgc-sys">${esc(m.text)}</div>`;
      const mine = m.uid && m.uid === s.self.uid;
      const aliasing = m.alias || (mine ? '我' : '成员');
      const atMe = !mine && s.self.alias && String(m.text || '').includes('@' + s.self.alias);
      const inv = m.invite;
      const plan = m.link && m.link.kind === 'plan' ? m.link : null;
      /* L0 雷达全开：闲聊折叠 + 提示「先干活」，不扣分不拒收 */
      const fold = T && ti && ti.radar === 'full' && T.isChitChat(m.text);
      return `<div class="lgc-msg${mine ? ' mine' : ''}${atMe ? ' atme' : ''}${fold ? ' folded' : ''}">
        <span class="lgc-who">${esc(aliasing)}</span>
        <span class="lgc-time">${lgcTime(m.at)}</span>
        ${atMe ? '<span class="lgc-at-me">@ 你</span>' : ''}
        ${
          fold
            ? `<details class="lgc-fold"><summary>💤 雷达折叠：像闲聊，先干活</summary><div class="lgc-text">${lgcTextHTML(m.text, s)}</div></details>`
            : `<div class="lgc-text">${lgcTextHTML(m.text, s)}</div>`
        }
        ${
          plan
            ? `<div class="lgc-link plan"><span class="lgc-link-t">📋 计划包 · <b>${esc(plan.name)}</b>（${Number(plan.count) || 0} 个计划 · ${Math.round(String(plan.text || '').length / 1024)} KB）</span>
                 <button class="btn small" data-planid="${esc(m.id)}">预览导入</button></div>`
            : ''
        }
        ${
          inv
            ? `<div class="lgc-invite">
                 <div class="lgc-invite-t">自习房邀请 · 房间码 <b>${esc(inv.code)}</b></div>
                 <button class="btn small" data-room="${esc(inv.ip)}|${Number(inv.port) || 0}|${esc(inv.code)}">进入房间</button>
               </div>`
            : ''
        }
        ${s.isHost && !mine ? `<button class="lgc-op" data-mute="${esc(m.uid || '')}" data-alias="${esc(aliasing)}">禁言</button>
        <button class="lgc-op" data-fold="${esc(m.uid || '')}" data-alias="${esc(aliasing)}" title="Lv1 劝导：折叠+私信提醒，不公开处刑">提醒</button>` : ''}
      </div>`;
    })
    .join('');
}

function lgcHostHTML(s) {
  const r = s.rules || {};
  const levels = (window.PQLegionChannel && PQLegionChannel.levels()) || [];
  const now = Date.now();
  const muted = Object.entries(s.mutes || {})
    .map(([uid, m]) => ({ uid, m }))
    .filter((x) => x.m && Number(x.m.until) > now)
    .map((x) => {
      const hit = (s.log || []).find((y) => y && y.uid === x.uid && y.alias);
      const alias = (hit && hit.alias) || '成员';
      return `<div class="lgc-muted"><span>${esc(alias)} · 剩 ${Math.ceil((Number(x.m.until) - now) / 60e3)} 分钟</span>
        <button class="lgc-op" data-unmute="${esc(x.uid)}">解除</button></div>`;
    })
    .join('');

  return `
    <details class="lgc-set">
      <summary>频道规则（只有军团主能改）</summary>
      <div class="set-row">
        <div class="set-info">
          <div class="st">开启频道</div>
          <div class="sd">关掉之后频道只读：历史还在，谁也不能发。</div>
        </div>
        <div class="switch ${r.on !== false ? 'on' : ''}" id="lgc-on"></div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="st">严格度</div>
          <div class="sd">决定刷屏与复读的阈值，也决定发言需要的信誉分。</div>
        </div>
        <select class="select" id="lgc-level">
          ${levels
            .map((l) => `<option value="${l.key}" ${r.level === l.key ? 'selected' : ''}>${l.label}（禁言 ${l.muteMin} 分钟 · 信誉 ≥ ${l.floor}）</option>`)
            .join('')}
        </select>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="st">禁言时长</div>
          <div class="sd">违规一次关多久。选「跟随档位」就是每个档位的默认值。</div>
        </div>
        <select class="select" id="lgc-mute">
          ${[
            [0, '跟随档位'],
            [3, '3 分钟'],
            [5, '5 分钟'],
            [10, '10 分钟'],
            [20, '20 分钟'],
            [30, '30 分钟'],
          ]
            .map(([v, t]) => `<option value="${v}" ${Number(r.muteMin) === v ? 'selected' : ''}>${t}</option>`)
            .join('')}
        </select>
      </div>
      <div class="lgc-words">
        <div class="st">自定义词</div>
        <div class="sd">每行一个，或用逗号隔开；最多 20 个，每个 2–8 个字。内置词表一直都在。</div>
        <textarea class="input" id="lgc-words" rows="3" maxlength="240" placeholder="例如：广告狗&#10;代练">${esc((r.words || []).join('\n'))}</textarea>
      </div>
      <div class="lg-actions">
        <button class="btn" id="lgc-save">保存规则</button>
        <span class="chat-tip">改完立即生效，成员那边自动跟上</span>
      </div>
      ${muted ? `<div class="lgc-muted-list"><div class="st" style="margin-bottom:6px">正在禁言</div>${muted}</div>` : ''}
    </details>`;
}

function lgChatHTML() {
  const C = window.PQLegionChannel;
  if (!C) return '';
  const s = C.state();
  const room = state.room || {};
  const canInvite = !!(room.inRoom && room.isHost);
  const ti = window.__pqTier || null;
  const tierLine = ti
    ? `<div class="lgc-tier">闲聊档位：<b>${esc(ti.label)}</b> · ${esc(ti.note)}${ti.collective ? ` · 集体任务「${esc(ti.collective.title)}」${ti.collective.status === 'done' ? '✅ 已达成' : `进度 ${ti.collective.progress}% / 基线 ${ti.collective.target}%`}` : ''}</div>`
    : '';
  return `
    <div class="panel" id="lg-chat">
      <h3>军团频道
        <span class="lgc-mention" id="lgc-mention" ${s.mentions ? '' : 'hidden'}>${s.mentions || 0}</span>
        <span class="lgc-tag">${esc(s.rulesText)}</span>
      </h3>
      ${tierLine}
      <div class="lgc-log" id="lgc-log">${lgcLogHTML(s)}</div>
      <div class="lgc-send">
        <div class="lgc-at-wrap">
          <input class="input" id="lgc-in" maxlength="200" placeholder="${esc(s.canSend ? '说点什么，@ 可以点名（200 字以内）' : s.why)}" ${s.canSend ? '' : 'disabled'} />
          <div class="lgc-at-box" id="lgc-at-box" hidden></div>
        </div>
        <button class="btn ghost" id="lgc-attach" title="转发软件里的东西">📎</button>
        ${canInvite ? '<button class="btn ghost" id="lgc-invite" title="把房间连接信息发给全团">邀进房间</button>' : ''}
        <button class="btn" id="lgc-send" ${s.canSend ? '' : 'disabled'}>发送</button>
      </div>
      <div class="lgc-attach-menu" id="lgc-attach-menu" hidden>
        <div class="lgc-attach-t">转发到频道</div>
        <button class="lgc-attach-item" data-attach="plan-all">📋 我的全部计划（.pqplan）</button>
        <button class="lgc-attach-item" data-attach="plan-normal">📋 只要普通计划</button>
        <button class="lgc-attach-item" data-attach="plan-contract">📋 只要契约计划</button>
        <button class="lgc-attach-item" data-attach="room">🏠 我的房间链接</button>
        <button class="lgc-attach-item" data-attach="legion">🛡 我的军团链接</button>
        <div class="lgc-attach-note">计划里有备注，转发前会再问一次。链接是 pq:// 文本，贴到微信也能被人打开。</div>
      </div>
      <div class="lgc-hint" id="lgc-hint">${esc(
        s.canSend
          ? '频道里只有军团成员。@ 昵称可以点名；开了自习房的话，可以直接把房间邀请发到频道里。'
          : s.why
      )}</div>
      ${s.isHost ? lgcHostHTML(s) : '<div class="lgc-hint">规则由团长设定，写在频道顶部，全团一致。</div>'}
    </div>`;
}

/* 只重画消息区与提示，不整页重渲染 —— 否则输入到一半会被清掉 */
function paintChat() {
  const C = window.PQLegionChannel;
  const box = $('#lgc-log');
  if (!C || !box) return;
  const s = C.state();
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = lgcLogHTML(s);
  if (stick) box.scrollTop = box.scrollHeight;

  const inp = $('#lgc-in');
  const btn = $('#lgc-send');
  const hint = $('#lgc-hint');
  if (inp) {
    inp.disabled = !s.canSend;
    inp.placeholder = s.canSend ? '说点什么，@ 可以点名（200 字以内）' : s.why;
  }
  if (btn) btn.disabled = !s.canSend;
  if (hint) hint.textContent = s.canSend ? s.err || '频道里只有军团成员。@ 昵称可以点名；开了自习房的话，可以直接把房间邀请发到频道里。' : s.why;
  const tag = $('.lgc-tag');
  if (tag) tag.textContent = s.rulesText;
  const badge = $('#lgc-mention');
  if (badge) {
    badge.textContent = String(s.mentions || 0);
    badge.hidden = !s.mentions;
  }
}

/* @ 选择器：输入 @ 之后就列出团里的人，点一下补全 */
function paintAtBox(C) {
  const box = $('#lgc-at-box');
  const inp = $('#lgc-in');
  if (!box || !inp) return;
  const v = String(inp.value || '');
  const caret = inp.selectionStart == null ? v.length : inp.selectionStart;
  const before = v.slice(0, caret);
  const m = /@([^\s@]{0,12})$/.exec(before);
  if (!m) {
    box.hidden = true;
    return;
  }
  const q = m[1];
  const me = C.state().self || {};
  const list = (C.state().roster || [])
    .filter((x) => x && x.alias && x.uid !== me.uid)
    .filter((x) => !q || x.alias.includes(q))
    .slice(0, 6);
  if (!list.length) {
    box.hidden = true;
    return;
  }
  box.innerHTML = list.map((x) => `<button class="lgc-at-item" data-alias="${esc(x.alias)}">@${esc(x.alias)}</button>`).join('');
  box.hidden = false;
  box.querySelectorAll('[data-alias]').forEach((b) => {
    b.onmousedown = (e) => e.preventDefault(); // 别让输入框先失焦
    b.onclick = () => {
      const alias = b.getAttribute('data-alias');
      const head = v.slice(0, caret - q.length) + alias + ' ';
      inp.value = head + v.slice(caret);
      box.hidden = true;
      inp.focus();
      try {
        inp.setSelectionRange(head.length, head.length);
      } catch (_) {}
    };
  });
}

/* ---- 链接落地：房间 / 军团 / 计划 ----
   这些处理函数在军团频道和自习房聊天里共用：同一个 pq:// 链接，在哪都能点开。 */

/* 房间里的「军团成员」条：昵称 + 信誉等级，点名字就把这间房 @ 给他 */
async function paintRoomLegion() {
  const bar = $('#room-legion');
  if (!bar) return;
  let ls = null;
  try {
    ls = await api.legionStatus();
  } catch (_) {}
  if (!ls || !ls.inLegion) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  const list = (ls.members || []).filter((m) => m && !m.self);
  const items = list.length
    ? list
        .map(
          (m) =>
            `<button class="rl-item" data-rl-alias="${esc(m.alias || '')}" title="把这间自习房发给他">${esc(
              m.alias || '成员'
            )} ${govTierChip(m.credit)}</button>`
        )
        .join('')
    : '<span class="rl-empty">团里暂时没有别人</span>';
  bar.innerHTML = `<span class="rl-t">🛡 军团 <b>${esc(ls.code || '')}</b></span>
    <div class="rl-list">${items}</div>
    <span class="rl-tip">点名字 = 把这间房 @ 给他</span>`;
  bar.hidden = false;
  bar.querySelectorAll('[data-rl-alias]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      await inviteLegionMateToRoom(b.getAttribute('data-rl-alias'));
      b.disabled = false;
    };
  });
}

/* 房间里的 @ 选择器：跟军团频道同一套，只是名单来自房间成员 */
function paintRoomAtBox() {
  const box = $('#chat-at-box');
  const inp = $('#chat-input');
  if (!box || !inp) return;
  const v = String(inp.value || '');
  const caret = inp.selectionStart == null ? v.length : inp.selectionStart;
  const m = /@([^\s@]{0,12})$/.exec(v.slice(0, caret));
  if (!m) {
    box.hidden = true;
    return;
  }
  const q = m[1];
  const me = (state && state.profile && state.profile.name) || '我';
  const list = roomRoster()
    .filter((x) => x && x.alias && x.alias !== me)
    .filter((x) => !q || x.alias.includes(q))
    .slice(0, 6);
  if (!list.length) {
    box.hidden = true;
    return;
  }
  box.innerHTML = list.map((x) => `<button class="lgc-at-item" data-alias="${esc(x.alias)}">@${esc(x.alias)}</button>`).join('');
  box.hidden = false;
  box.querySelectorAll('[data-alias]').forEach((b) => {
    b.onmousedown = (e) => e.preventDefault(); // 别让输入框先失焦
    b.onclick = () => {
      const alias = b.getAttribute('data-alias');
      const head = v.slice(0, caret - q.length) + alias + ' ';
      inp.value = head + v.slice(caret);
      box.hidden = true;
      inp.focus();
      try {
        inp.setSelectionRange(head.length, head.length);
      } catch (_) {}
    };
  });
}

function hideRoomAtBox() {
  const b = $('#chat-at-box');
  if (b) b.hidden = true;
}

/* 房间聊天里转发：计划 / 房间 / 军团 —— 素材和军团频道同一套，只是终点不同 */
async function forwardToRoom(what, send) {
  const lib = window.PQLegionChat;
  if (!lib || typeof send !== 'function') return;
  try {
    if (what === 'room') {
      const info = await api.roomInviteInfo();
      if (!info || !info.ok) return toast('发不了房间链接', (info && info.message) || '先开一个自习房', true);
      const link = lib.buildLink('room', info.invite);
      if (!link) return toast('生成链接失败', '', true);
      const r = await send('自习房在这：' + link);
      return r && r.ok ? toast('房间链接已发到房间', '') : toast('没发出去', (r && r.message) || '', true);
    }
    if (what === 'legion') {
      const L = window.PQLegion ? window.PQLegion.info() : null;
      if (!L || !L.inLegion) return toast('你还没加入军团', '先加入一个军团才能发它的链接', true);
      let link = '';
      if (L.net === 'p2p') {
        const N = window.PQLegionNet;
        if (!N) return toast('这台设备没有异地通道', '', true);
        const r = await N.invite();
        if (!r || !r.ok) return toast('拿不到邀请码', (r && r.message) || '', true);
        link = lib.buildLink('legion', { net: 'p2p', code: L.code, invite: r.text });
      } else {
        link = lib.buildLink('legion', { net: 'lan', ip: L.ip, port: L.port, code: L.code });
      }
      if (!link) return toast('生成链接失败', '', true);
      const r = await send('军团在这儿：' + link);
      return r && r.ok ? toast('军团链接已发到房间', '') : toast('没发出去', (r && r.message) || '', true);
    }
    /* 计划包 */
    const scope = what === 'plan-normal' ? 'normal' : what === 'plan-contract' ? 'contract' : 'all';
    const f = await api.planfileForward(scope);
    if (!f || !f.ok) return toast('转发失败', (f && f.message) || '', true);
    if (!f.count) return toast('没有可转发的计划', '', true);
    const okIt = await confirmDialog(
      '转发计划到房间？',
      `「${f.name}」共 ${f.count} 个计划，约 ${Math.round((f.bytes || 0) / 1024)} KB。计划里的备注会一起发出去，房间里所有人都能看到。`
    );
    if (!okIt) return;
    const r = await send('分享一份计划：' + f.name, {
      kind: 'plan',
      name: f.name,
      count: f.count,
      text: f.text,
    });
    if (r && r.ok) toast('计划已发到房间', '对方点「合并导入」即可，不会覆盖他本机数据');
    else toast('没发出去', (r && r.message) || '', true);
  } catch (_) {
    toast('操作失败', '稍后再试', true);
  }
}

/* 在军团频道里点名：切到频道并把 @昵称 填进输入框（不自动发，留给人自己补话） */
function mentionInChannel(alias) {
  const a = String(alias || '').trim();
  if (!a) return;
  const inp = $('#lgc-in');
  if (!inp) return toast('频道还没加载好', '等一秒再点', true);
  const cur = String(inp.value || '');
  inp.value = (cur ? cur.replace(/\s+$/, '') + ' ' : '') + '@' + a + ' ';
  inp.focus();
  try {
    inp.setSelectionRange(inp.value.length, inp.value.length);
  } catch (_) {}
  const panel = $('#lg-chat');
  if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* 把当前自习房发给某个团员：优先走军团频道（会 @ 他），发不出去就退回复制 */
async function inviteLegionMateToRoom(alias) {
  const a = String(alias || '').trim();
  if (!a) return { ok: false };
  const lib = window.PQLegionChat;
  let info = null;
  try {
    info = await api.roomInviteInfo();
  } catch (_) {}
  if (!info || !info.ok) {
    toast('只有房主能直接邀请', (info && info.message) || '先开一个自习房', true);
    return { ok: false };
  }
  const link = lib && lib.buildLink ? lib.buildLink('room', info.invite) : '';
  if (!link) {
    toast('生成邀请失败', '', true);
    return { ok: false };
  }
  const text = `@${a} 来我的自习房：${link}`;

  let sent = false;
  const C = window.PQLegionChannel;
  if (C) {
    const s = C.state ? C.state() : null;
    if (s && s.code && s.canSend) {
      try {
        const r = await C.send(text);
        sent = !!(r && r.ok);
      } catch (_) {}
    }
  }
  if (!sent && typeof api.legionChatSend === 'function') {
    try {
      const r = await api.legionChatSend(text);
      sent = !!(r && r.ok);
    } catch (_) {}
  }
  if (sent) {
    toast(`已把房间发给 ${a}`, '他点军团频道里的「进入房间」就能进来');
    return { ok: true };
  }
  copyText(text);
  toast('军团频道没连上', '邀请已复制到剪贴板，发给他也一样');
  return { ok: false };
}

async function enterRoomFromLink(b) {
  if (!b) return;
  const [ip, port, code] = String(b.getAttribute('data-room') || '').split('|');
  if (!ip || !code) return toast('邀请信息不完整', '', true);
  const label = b.textContent;
  b.disabled = true;
  b.textContent = '连接中…';
  try {
    const r = await api.roomJoin({ ip, port: Number(port) || 0, code });
    if (!r || !r.ok) {
      toast('进不去', (r && r.message) || '房主可能已经关了房间', true);
      b.disabled = false;
      b.textContent = label;
      return;
    }
    toast('已进入房间', '同一个房间才能看到彼此的状态');
    switchView('study');
  } catch (_) {
    toast('进不去', '网络没通，稍后再试', true);
    b.disabled = false;
    b.textContent = label;
  }
}

async function joinLegionFromLink(raw, L) {
  let link = null;
  try {
    link = JSON.parse(decodeURIComponent(String(raw || '')));
  } catch (_) {}
  if (!link || !link.kind === 'legion') return toast('链接坏了', '让团长再发一次', true);
  const me = L || (window.PQLegion ? PQLegion.info() : null);
  if (me && me.joined) {
    if (String(me.code || '') === String(link.code || '')) return toast('这就是你现在的军团', '');
    return toast('你已经在军团里了', '先在军团页退出当前军团，再点这条链接', true);
  }
  if (link.net === 'p2p') {
    if (!link.invite) return toast('链接里没有邀请码', '让团长重新转发一次', true);
    const r = await PQLegion.joinP2P({ invite: link.invite, alias: (state.profile && state.profile.name) || '' });
    if (!r || !r.ok) return toast('加入失败', (r && r.message) || '', true);
    window.__lgReply = r.text || '';
    toast('回执码已生成', '发给团长，他粘贴后就连上了');
    switchView('legion');
    render(false);
    return;
  }
  const r = await PQLegion.join({ ip: link.ip, port: Number(link.port) || 0, code: link.code, alias: '' });
  if (!r || !r.ok) return toast('加入失败', (r && r.message) || '', true);
  toast('已加入军团', '军团码 ' + link.code);
  switchView('legion');
}

/* 聊天里的 PK 挑战链接：先弹「是否应战」确认，确认后才应战；阿刺此时会说一句话 */
async function acceptPkFromLink(raw) {
  let link = null;
  try {
    link = JSON.parse(decodeURIComponent(String(raw || '')));
  } catch (_) {}
  if (!link || link.kind !== 'pk' || !link.matchId) return toast('PK 链接坏了', '让对方再发一次', true);
  const ageDays = link.t ? (Date.now() - Number(link.t)) / 86400000 : 0;
  if (ageDays > (Number(link.days) || 3)) return toast('这张挑战券已过期', '', true);
  if (!api || typeof api.aciAction !== 'function') return toast('PK 需桌面版', '', true);
  const yes = await confirmDialog(
    '是否应战？',
    `${link.name || '对手'} 发来 PK 挑战：对方战力 ${Number(link.rate) || 0}，有效期 ${Number(link.days) || 3} 天。应战消耗 1 张挑战券。`
  );
  if (!yes) return;
  const r = await api.aciAction('acceptPkInvite', {
    invite: { matchId: link.matchId, name: link.name, rate: link.rate, days: link.days, t: link.t },
  });
  if (!r || !r.ok) return toast('应战失败', (r && r.message) || '检查挑战券/冷却', true);
  /* 阿刺在应战这一刻说一句话，并切到战斗造型 */
  if (window.PQBuddy) {
    try {
      const fightLines = [
        '（阿刺的活动刺全竖起来了）行，这架我陪你打。',
        '对手战力 ' + (Number(link.rate) || 0) + '？够看。让我热热身。',
        '挑战接了。别拖后腿——你本周完成率可得跟上。',
      ];
      if (window.PQBuddy.setFighting) window.PQBuddy.setFighting(true, 8000);
      if (window.PQBuddy.say) window.PQBuddy.say(fightLines[Math.floor(Math.random() * fightLines.length)], 'angry');
    } catch (_) {}
  }
  toast('应战成功 ⚔️', '阿刺已进入战斗状态');
  if (typeof render === 'function') render(false);
}

/* 频道里「转发」：计划包走附件，房间/军团走 pq:// 链接文本 */
async function forwardToChannel(C, L, what) {
  const lib = window.PQLegionChat;
  try {
    if (what === 'room') {
      const info = await api.roomInviteInfo();
      if (!info || !info.ok) return toast('发不了房间链接', (info && info.message) || '先开一个自习房', true);
      const link = lib.buildLink('room', info.invite);
      const r = await C.send('自习房在这：' + link, { invite: info.invite });
      return r && r.ok ? toast('房间链接已发到频道', '') : toast('没发出去', (r && r.message) || '', true);
    }
    if (what === 'legion') {
      let link = '';
      if (L.net === 'p2p') {
        const N = window.PQLegionNet;
        if (!N) return toast('这台设备没有异地通道', '', true);
        const r = await N.invite();
        if (!r || !r.ok) return toast('拿不到邀请码', (r && r.message) || '', true);
        link = lib.buildLink('legion', { net: 'p2p', code: L.code, invite: r.text });
      } else {
        link = lib.buildLink('legion', { net: 'lan', ip: L.ip, port: L.port, code: L.code });
      }
      if (!link) return toast('生成链接失败', '', true);
      const r = await C.send('军团在这儿：' + link);
      return r && r.ok ? toast('军团链接已发到频道', '') : toast('没发出去', (r && r.message) || '', true);
    }
    /* 计划包 */
    const scope = what === 'plan-normal' ? 'normal' : what === 'plan-contract' ? 'contract' : 'all';
    const f = await api.planfileForward(scope);
    if (!f || !f.ok) return toast('转发失败', (f && f.message) || '', true);
    if (!f.count) return toast('没有可转发的计划', '', true);
    const okIt = await confirmDialog(
      '转发计划到频道？',
      `「${f.name}」共 ${f.count} 个计划，约 ${Math.round((f.bytes || 0) / 1024)} KB。计划里的备注会一起发出去，军团里所有人都能看到。`
    );
    if (!okIt) return;
    const r = await C.send('分享一份计划：' + f.name, { link: { kind: 'plan', name: f.name, count: f.count, text: f.text } });
    if (r && r.ok) toast('计划已发到频道', '对方点「合并导入」即可，不会覆盖他本机数据');
    else toast('没发出去', (r && r.message) || '', true);
  } catch (_) {
    toast('操作失败', '稍后再试', true);
  }
}

function bindLegionChat(L) {
  const C = window.PQLegionChannel;
  if (!C) return;

  C.configure({
    code: L.code || '',
    role: L.role === 'host' ? 'host' : 'member',
    net: L.net === 'p2p' ? 'p2p' : 'lan',
    self: { uid: L.uid || '', alias: L.alias || '我', credit: (state.credit && state.credit.score) || 0 },
  });

  /* 名册：局域网从主进程拿，异地从网格名册拿，合并成同一份给 @ 用 */
  (async () => {
    const list = [];
    try {
      const r = await api.legionStatus();
      for (const m of (r && r.members) || []) list.push({ uid: m.uid, alias: m.alias, credit: 0 });
    } catch (_) {}
    const M = window.PQLegionMesh;
    if (M && typeof M.info === 'function') {
      try {
        const i = M.info();
        for (const m of (i && i.roster) || []) list.push({ uid: m.uid, alias: m.alias, credit: m.credit });
      } catch (_) {}
    }
    if (!list.some((x) => x.uid === L.uid)) list.push({ uid: L.uid, alias: L.alias || '我', credit: 0 });
    C.setRoster(list);
    paintChat();
  })();

  C.setMentionHandler((m) => {
    /* @ 你 的消息走同一个弹窗体系（限流/去重/静音规则一致），而不是另外弹一个 toast */
    if (!msgCenter) {
      toast('有人在频道里 @ 你', `${(m && m.alias) || '成员'}：${String((m && m.text) || '').slice(0, 24)}`);
      return;
    }
    let st = null;
    try { st = C.state(); } catch (_) {}
    msgCenter.push({
      kind: 'channel',
      convId: (st && st.code) || 'ch',
      name: '军团频道',
      avatar: '📣',
      from: (m && m.alias) || '成员',
      text: (m && m.text) || '',
      id: (m && m.id) || '',
      mention: true,
    });
    paintNavDots();
  });

  if (lgcUnsub) {
    try {
      lgcUnsub();
    } catch (_) {}
  }
  lgcUnsub = C.onChange(() => {
    notifyChannelMsgs(C);
    if (currentView !== 'legion') return;
    paintChat();
  });

  const doSend = async () => {
    const inp = $('#lgc-in');
    if (!inp) return;
    const text = String(inp.value || '').trim();
    if (!text) return;
    const btn = $('#lgc-send');
    if (btn) btn.disabled = true;
      const r = await C.send(text);
      if (r && r.ok) {
        inp.value = '';
        if (r.warn) { toast('发出去了，但注意一下', r.warn); alaScold('warn', r.warn); }
        paintChat();
      } else {
        toast('没发出去', (r && r.message) || '稍后再试');
        alaScold('chat', (r && r.message) || '频道拦截');
        paintChat();
      }
    if (btn) btn.disabled = false;
  };

  const sendBtn = $('#lgc-send');
  if (sendBtn) sendBtn.onclick = doSend;
  const inp = $('#lgc-in');
  if (inp) {
    inp.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      } else if (e.key === 'Escape') {
        const box = $('#lgc-at-box');
        if (box) box.hidden = true;
      }
    };
    inp.oninput = () => paintAtBox(C);
    inp.onfocus = () => C.markSeen();
  }

  /* 点一下消息区就算看过 @ */
  const logBox = $('#lgc-log');
  if (logBox) logBox.onclick = () => C.markSeen();

  const inviteBtn = $('#lgc-invite');
  if (inviteBtn) {
    inviteBtn.onclick = async () => {
      inviteBtn.disabled = true;
      try {
        const info = await api.roomInviteInfo();
        if (!info || !info.ok) {
          toast('发不了邀请', (info && info.message) || '先开一个自习房', true);
        } else {
          const r = await C.send('来我的自习房一起学会儿（房间码 ' + info.invite.code + '）', { invite: info.invite });
          if (r && r.ok) toast('邀请已发到频道', '点「进入房间」就能连上');
          else toast('没发出去', (r && r.message) || '', true);
          paintChat();
        }
      } catch (_) {
        toast('发不了邀请', '稍后再试', true);
      }
      inviteBtn.disabled = false;
    };
  }

  /* 转发菜单：计划 / 房间 / 军团 */
  const attachBtn = $('#lgc-attach');
  const attachMenu = $('#lgc-attach-menu');
  if (attachBtn && attachMenu) {
    attachBtn.onclick = () => {
      attachMenu.hidden = !attachMenu.hidden;
    };
    attachMenu.querySelectorAll('[data-attach]').forEach((b) => {
      b.onclick = async () => {
        const what = b.getAttribute('data-attach');
        attachMenu.hidden = true;
        await forwardToChannel(C, L, what);
      };
    });
  }

  /* 点开消息 = 已读；进入房间按钮 */
  document.querySelectorAll('#lg-chat [data-room]').forEach((b) => {
    b.onclick = () => enterRoomFromLink(b);
  });

  /* 计划包：预览（二次确认 + 来源标记）→ 24h 沙箱 → 手动转正 */
  document.querySelectorAll('#lg-chat [data-planid]').forEach((b) => {
    b.onclick = async () => {
      const id = b.getAttribute('data-planid');
      const msg = (C.state().log || []).find((m) => m && m.id === id);
      if (!msg || !msg.link) return toast('附件丢了', '让团长再发一次', true);
      b.disabled = true;
      b.textContent = '预览中…';
      await openPlanPreview(msg.link.text, msg.uid || '', msg.alias || '');
      b.disabled = false;
      b.textContent = '预览导入';
    };
  });

  /* 军团链接 */
  document.querySelectorAll('#lg-chat [data-legion]').forEach((b) => {
    b.onclick = () => joinLegionFromLink(b.getAttribute('data-legion'), L);
  });
  /* PK 挑战链接：点开先弹「是否应战」确认 */
  document.querySelectorAll('#lg-chat [data-pk]').forEach((b) => {
    b.onclick = () => acceptPkFromLink(b.getAttribute('data-pk'));
  });

  /* 团长：禁言 / 解除 */
  document.querySelectorAll('#lg-chat [data-mute]').forEach((b) => {
    b.onclick = async () => {
      const uid = b.getAttribute('data-mute');
      const alias = b.getAttribute('data-alias') || '成员';
      const r = await C.mute(uid, (C.state().rules || {}).muteMin || 5, '团长处理');
      toast(r && r.ok ? `已禁言 ${alias}` : '没成功', (r && r.message) || '');
      paintChat();
    };
  });
  document.querySelectorAll('#lg-chat [data-unmute]').forEach((b) => {
    b.onclick = async () => {
      const r = await C.unmute(b.getAttribute('data-unmute'));
      toast(r && r.ok ? '已解除' : '没成功', (r && r.message) || '');
      paintChat();
    };
  });

  /* 团长：规则编辑 */
  const on = $('#lgc-on');
  if (on) {
    on.onclick = () => {
      on.classList.toggle('on');
      C.setRules({ on: on.classList.contains('on') }).then(() => paintChat());
    };
  }
  const save = $('#lgc-save');
  if (save) {
    save.onclick = async () => {
      const level = ($('#lgc-level') || {}).value || 'normal';
      const muteRaw = ($('#lgc-mute') || {}).value || '0';
      const words = String(($('#lgc-words') || {}).value || '');
      const patch = { level, words: words.split(/[\n,，、;；|]+/).filter(Boolean) };
      if (Number(muteRaw) > 0) patch.muteMin = Number(muteRaw);
      save.disabled = true;
      const r = await C.setRules(patch);
      save.disabled = false;
      if (!r || !r.ok) return toast('没保存', (r && r.message) || '稍后再试');
      toast('规则已更新', '全团立即生效');
      render(false);
    };
  }
}


/* 军团纪律卡：把「能不能发言 / 能不能入团 / 契约 / 异常标记」摊开给人看，
   不做暗箱处罚 —— 罚了要说清为什么、怎么解。 */
function discPanelHTML() {
  const d = state.discipline || {};
  const reasons = Array.isArray(d.reasons) ? d.reasons : [];
  const contracts = Array.isArray(d.contracts) ? d.contracts : [];
  const flags = Array.isArray(d.flags) ? d.flags : [];
  const frozen = !!d.frozen;
  const banned = !!d.banned;
  const chip = (ok, on, off) => `<span class="lg-chip ${ok ? '' : 'warm'}">${ok ? on : off}</span>`;
  const fmtLeft = (t) => {
    const ms = Number(t) - Date.now();
    if (ms <= 0) return '已到期';
    const h = Math.floor(ms / 3600e3);
    return h >= 1 ? `${h} 小时后可解` : `${Math.max(1, Math.ceil(ms / 60e3))} 分钟后可解`;
  };
  return `
    <div class="panel" id="disc-panel">
      <h3>我的纪律状态</h3>
      <div class="lg-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
        ${chip(d.canSpeak !== false, '发言：正常', '发言：受限')}
        ${chip(d.canJoinLegion !== false, '军团：正常', banned ? '军团：永久封禁' : '军团：冻结中')}
        ${chip(d.canPk !== false, 'PK：可参加', 'PK：暂不可')}
        <span class="lg-chip">逃兵 ${Number(d.desertCount) || 0} 次</span>
        <span class="lg-chip">挂机作废 ${Number(d.voidCount) || 0} 次</span>
      </div>
      ${reasons.length ? `<div class="sd" style="color:var(--amber);margin-bottom:8px">${reasons.map((x) => esc(x)).join('<br>')}</div>` : '<div class="sd" style="margin-bottom:8px">一切正常。扣分只扣「专注期离开」和「挂机刷时长」，正常翻页、敲键盘不会触发。</div>'}
      ${frozen && !banned ? `<div class="lg-actions"><button class="btn" id="disc-thaw">连续打卡 3 天，点这里解冻</button><span class="chat-tip">解冻不清空纪录，但逃兵计数会归零</span></div>` : ''}

      <h4 style="margin:14px 0 6px">契约任务（押金托管 + 见证人）</h4>
      <div class="sd" style="margin-bottom:8px">立契约时押金先扣走；按时完成原额退回，违约就没收并扣信誉分。见证人不能是自己。</div>
      <div class="lg-fields">
        <input class="input" id="disc-ct-title" placeholder="要做什么（例如：背 50 个单词）" maxlength="40" />
        <input class="input" id="disc-ct-deposit" type="number" min="10" max="100" value="20" style="max-width:110px" />
        <input class="input" id="disc-ct-witness" placeholder="见证人（军团成员昵称）" maxlength="24" />
        <input class="input" id="disc-ct-hours" type="number" min="1" max="720" value="24" style="max-width:110px" />
      </div>
      <div class="lg-actions" style="margin-top:8px">
        <button class="btn" id="disc-ct-add">立契约</button>
        <span class="chat-tip">押金 10~100 分，截止时间按小时算</span>
      </div>
      ${contracts.length
      ? contracts
        .map((c) => {
          const open = c.status === 'open';
          const late = open && Date.now() > Number(c.dueAt) + 12 * 3600e3;
          return `<div class="fi-row" style="align-items:center">
                  <b>${esc(c.title)}</b>
                  <span>押 ${Number(c.deposit) || 0} 分 · 见证人 ${esc(c.witness || '—')} · ${open ? (late ? '已过宽限' : fmtLeft(c.dueAt)) : c.status === 'done' ? '已完成' : '已违约'}</span>
                  ${open ? `<span><button class="btn ghost" data-disc-done="${esc(c.id)}">完成</button><button class="btn ghost" data-disc-fail="${esc(c.id)}">违约</button></span>` : ''}
                </div>`;
        })
        .join('')
      : '<div class="sd">还没有进行中的契约。</div>'}

      <h4 style="margin:14px 0 6px">异常标记（提交人工确认）</h4>
      ${flags.length
      ? flags
        .map(
          (f) => `<div class="fi-row" style="align-items:center">
                  <b>${esc(f.detail || f.kind)}</b>
                  <span>${f.status === 'pending' ? '待确认' : f.status === 'upheld' ? '已坐实' : '已撤销'}</span>
                  ${f.status === 'pending' ? `<span><button class="btn ghost" data-disc-up="${esc(f.id)}">坐实</button><button class="btn ghost" data-disc-down="${esc(f.id)}">误判</button></span>` : ''}
                </div>`
        )
        .join('')
      : '<div class="sd">没有异常标记。真被误判了，点「误判」即可撤销，不会扣分。</div>'}
    </div>`;
}

function bindDiscPanel() {
  const thaw = $('#disc-thaw');
  if (thaw)
    thaw.onclick = async () => {
      const r = await api.discThaw();
      toast(r.ok ? '已解冻' : '还差几天', r.ok ? '下次别再中途切走了' : r.message || '', !r.ok);
      if (r.ok) render(false);
    };

  const add = $('#disc-ct-add');
  if (add)
    add.onclick = async () => {
      const hours = Math.max(1, Math.min(720, Number($('#disc-ct-hours').value) || 24));
      const r = await api.discContractNew({
        title: $('#disc-ct-title').value.trim(),
        deposit: Number($('#disc-ct-deposit').value) || 0,
        witness: $('#disc-ct-witness').value.trim(),
        dueAt: Date.now() + hours * 3600e3,
      });
      if (!r.ok) return toast('立不了契约', r.message || '', true);
      toast('契约已立', `押金 ${r.contract.deposit} 分已托管，见证人 ${r.contract.witness}`);
      render(false);
    };

  document.querySelectorAll('[data-disc-done]').forEach((b) => {
    b.onclick = async () => {
      const r = await api.discContractSettle({ id: b.getAttribute('data-disc-done'), done: true });
      if (!r.ok) return toast('结算失败', r.message || '', true);
      toast('契约完成', r.message);
      render(false);
    };
  });
  document.querySelectorAll('[data-disc-fail]').forEach((b) => {
    b.onclick = async () => {
      const ok = await confirmDialog('确认违约？', '押金会被没收，信誉分也会扣。');
      if (!ok) return;
      const r = await api.discContractSettle({ id: b.getAttribute('data-disc-fail'), done: false });
      if (!r.ok) return toast('还不用判违约', r.message || '', true);
      toast('已按违约处理', r.message, true);
      render(false);
    };
  });

  document.querySelectorAll('[data-disc-up]').forEach((b) => {
    b.onclick = async () => {
      const ok = await confirmDialog('确认这条异常属实？', '坐实后信誉分清零，军团功能永久封禁（打卡和个人计划不受影响）。');
      if (!ok) return;
      const r = await api.discReview({ id: b.getAttribute('data-disc-up'), uphold: true });
      toast(r.ok ? '已处理' : '处理失败', r.message || '', true);
      render(false);
    };
  });
  document.querySelectorAll('[data-disc-down]').forEach((b) => {
    b.onclick = async () => {
      const r = await api.discReview({ id: b.getAttribute('data-disc-down'), uphold: false });
      toast(r.ok ? '已撤销标记' : '处理失败', r.ok ? '没有扣分，也不会留记录' : r.message || '', !r.ok);
      render(false);
    };
  });
}

/* ---------------- 军团治理：团内目录 · 投票 · 职务 ---------------- */
let govCache = null;

function govTierChip(credit) {
  const G = window.PQLegionGov;
  if (!G || credit == null || !Number.isFinite(Number(credit))) return '<span class="lg-chip">等级未知</span>';
  const i = G.tierIndex(credit);
  const t = G.tierOf(credit);
  /* 同一件事两套叫法：分档「良好」= 特权档「L2 社交」。这里两个都写，免得用户对不上。 */
  const lv = ['', 'L1', 'L2', 'L3'][i] || '';
  return `<span class="lg-chip lg-tier t${i}">${t.icon} ${t.name}${lv ? ' · ' + lv : ''}</span>`;
}

/* L3 荣耀特权：团内名册挂 ✦ 星标。分数不够 120 的人这里什么都没有，
   不是「藏起来」，是真的没有这个身份。 */
function govStarChip(credit) {
  const n = Number(credit);
  if (!Number.isFinite(n) || n < 120) return '';
  return '<span class="lg-chip gold" title="信誉 ≥120 · L3 荣耀 · 守约者">✦ 守约者</span>';
}

function govRoleChip(roleId) {
  const G = window.PQLegionGov;
  const r = G && G.ROLES[roleId];
  if (!r) return '';
  return `<span class="lg-chip warm">${r.icon} ${r.name}</span>`;
}

/* 团长选举卡：团长退团后全团投票接任。
   开放中：候选人 + 参选/投票；结算后：结果或失败原因。 */
function govElectionHTML(c) {
  const G = window.PQLegionGov;
  const e = c && c.election;
  if (!G || !e) return '';
  const self = c.self || {};
  const joined = !!self.joined;
  const canAct = joined && Number(self.tier) >= 1;
  const iAmCandidate = Array.isArray(e.candidates) && e.candidates.some((x) => x.uid === self.uid);
  const myVote = e.ballots && self.uid ? e.ballots[self.uid] : '';
  const candRows = (Array.isArray(e.candidates) ? e.candidates : [])
    .map((x) => {
      const n = e.counts && e.counts[x.uid] != null ? e.counts[x.uid] : 0;
      const showN = e.status !== 'open';
      return `<div class="lg-row">
        <div class="lg-row-main">
          <b>${esc(x.alias || '成员')}</b> ${govTierChip(x.credit)}
          ${e.result === x.uid ? '<span class="lgc-at-me">新团长</span>' : ''}
          <div class="lg-row-sub">${showN ? `得 ${n} 票` : '参选中'}${myVote === x.uid && e.status === 'open' ? ' · 你投给了他' : ''}</div>
        </div>
        ${e.status === 'open' && canAct ? `<div class="lg-row-ops"><button class="btn small ${myVote === x.uid ? '' : 'ghost'}" data-gv-el-vote="${esc(x.uid)}">${myVote === x.uid ? '已投' : '投票'}</button></div>` : ''}
      </div>`;
    })
    .join('');

  const leftMin = Math.max(0, Math.ceil((Number(e.leftMs) || 0) / 60e3));
  let head = '';
  if (e.status === 'open') {
    head = `<div class="sd">团长「${esc(e.prevAlias || '前任')}」已退团。10 分钟选举进行中（还剩约 ${leftMin} 分钟）：参选或投票，结算时票多者接任；参与人数不足则选举作废。</div>`;
  } else if (e.status === 'pass') {
    head = `<div class="sd">选举完成，新团长已生效。公告记录在治理台账里。</div>`;
  } else {
    head = `<div class="sd">上一场选举没有成（${e.candidates && e.candidates.length ? '投票人数不足' : '无人参选'}），团里暂时没有团长。</div>`;
  }

  const actions = e.status === 'open'
    ? canAct && !iAmCandidate
      ? '<div class="lg-actions" style="margin-top:8px"><button class="btn ghost" id="gv-el-campaign">🙋 参选团长</button></div>'
      : iAmCandidate
        ? '<div class="sd" style="margin-top:8px">你是候选人。拉票可以，但别许诺加分——职务不给分，规矩写在这里。</div>'
        : ''
    : e.status === 'fail' && canAct
      ? '<div class="lg-actions" style="margin-top:8px"><button class="btn ghost" id="gv-el-restart">重新发起选举</button></div>'
      : '';

  return `<div class="lg-form-t" style="margin-top:16px">团长选举</div>
    ${head}
    <div class="lg-rows" style="margin-top:8px">${candRows || '<div class="sd">还没有人参选。</div>'}</div>
    ${e.status === 'open' ? `<div class="sd" style="margin-top:6px">已收到 ${Number(e.joined) || 0} 票 · 需要 ≥ ${Number(e.need) || 2} 人参与（在线过半）</div>` : ''}
    ${actions}`;
}

/* 我在团里的信誉位置：只出自己的名次，不出别人的分数。
 * 这是「军团内可看到自己的排名」那条需求——排名给本人看，不是拿去比人。 */
function govRepRankHTML(c) {
  const G = window.PQLegionGov;
  const P = window.PQCreditPriv;
  const roster = (c && Array.isArray(c.roster) && c.roster) || [];
  const me = c && c.self && c.self.uid;
  if (!G || !P || !me) return '';
  const r = P.rank(roster, me);
  const lv = G.tierOf((c.self && c.self.credit) || 0);
  if (!r) {
    return `<div class="rp-rank">
      <div class="rp-rank-h">🪪 我在团里的信誉位置</div>
      <div class="sd">还没同步到别人的信誉等级 —— 等下一次心跳（或团长开一次房间）就能算出来。</div>
      <div class="sd">你自己的等级：<b>${lv.icon} ${lv.name}</b> · 具体分数只有你自己看得到。</div>
    </div>`;
  }
  const width = r.total > 1 ? Math.round(((r.total - r.pos + 1) / r.total) * 100) : 100;
  return `<div class="rp-rank">
    <div class="rp-rank-h">🪪 我在团里的信誉位置</div>
    <div class="rp-rank-main">
      <div class="rp-rank-pos"><b>${r.pos}</b><span>/ ${r.total} 位</span></div>
      <div class="rp-rank-meta">
        <div>${govTierChip((c.self && c.self.credit) || 0)} <span class="sd">高于团里 ${r.abovePct}% 的人</span></div>
        <div class="rp-rank-bar"><i style="width:${Math.max(4, width)}%"></i></div>
      </div>
    </div>
    <div class="sd">排名只用「已同步到等级」的 ${r.known} 位成员算，没同步的不猜。别人看得到你的等级（${lv.icon} ${lv.name}），看不到你的分数。</div>
  </div>`;
}

function govRosterRows(cache) {
  const G = window.PQLegionGov;
  const c = cache === undefined ? govCache || {} : cache || {};
  const list = Array.isArray(c.roster) ? c.roster : [];
  const me = (c.self && c.self.uid) || '';
  const roles = c.roles || {};
  if (!list.length) return '<div class="sd">还没同步到成员目录。让团长先开一次房间，或者等下一次心跳。</div>';
  return list
    .map((m) => {
      const isMe = m.uid === me;
      const roleId = roles[m.uid] || '';
      const hostMark = c.self && c.self.isHost && isMe ? '<span class="lg-chip warm">团长</span>' : '';
      return `<div class="lg-row" data-uid="${esc(m.uid)}">
        <div class="lg-row-main">
          <b>${esc(m.alias || '成员')}</b>${isMe ? ' <span class="sd">（我）</span>' : ''} ${hostMark} ${govRoleChip(roleId)}
          <div class="lg-row-sub">${govTierChip(m.credit)} ${govStarChip(m.credit)} ${m.online === false ? '<span class="sd">离线</span>' : ''}</div>
        </div>
        <div class="lg-row-ops">
          <button class="btn small ghost" data-gvat="${esc(m.uid)}" data-alias="${esc(m.alias || '成员')}" title="在频道里 @ 他">@</button>
          ${
            isMe
              ? ''
              : `<button class="btn small ghost" data-gvroom="${esc(m.uid)}" data-alias="${esc(m.alias || '成员')}" title="把这间自习房发给他">邀进房间</button>`
          }
          ${
            c.self && c.self.isHost && !isMe
              ? `<button class="btn small ghost" data-gvfold="${esc(m.uid)}" data-alias="${esc(m.alias || '成员')}" title="Lv1 劝导：折叠+私信提醒，3 次进观察名单">提醒</button>
                 <button class="btn small ghost" data-gvmod="${esc(m.uid)}" data-alias="${esc(m.alias || '成员')}" title="Lv2 管制：须填理由，副团长投票过半">管制</button>
                 <button class="btn small ghost" data-gvevict="${esc(m.uid)}" data-alias="${esc(m.alias || '成员')}" title="Lv3 驱逐：全员投票 2/3，7 天申诉期">驱逐</button>
                 <button class="btn small ghost" data-gvban="${esc(m.uid)}" data-alias="${esc(m.alias || '成员')}" title="计划文件黑名单：他的 .pqplan 自动拦截">拉黑计划</button>`
              : ''
          }
        </div>
      </div>`;
    })
    .join('');
}

function govVoteCard(v, cache) {
  const G = window.PQLegionGov;
  const c = cache === undefined ? govCache || {} : cache || {};
  const size = (c.self && c.self.rosterSize) || 1;
  const t = G ? G.tally(v, size, Date.now()) : { status: v.status, yes: 0, no: 0, need: 0, joined: 0, quorum: false, leftMs: 0 };
  const mine = (v.votes || {})[c.self ? c.self.uid : ''] || '';
  const typeName = G && G.TYPES[v.type] ? G.TYPES[v.type].name : '投票';
  const open = v.status === 'open';
  const leftMin = Math.ceil((t.leftMs || 0) / 60e3);
  const statusText =
    v.status === 'pass' ? '✅ 通过' : v.status === 'fail' ? '❌ 未通过' : v.status === 'void' ? '🚫 已作废（被举报）' : `⏳ 还有 ${leftMin} 分钟`;
  const roleName = v.role && G && G.ROLES[v.role] ? G.ROLES[v.role].name : '';
  const bar = `<div class="sd" style="margin-top:6px">同意 ${t.yes} · 反对 ${t.no} · 参与 ${t.joined}/${t.need} 人${t.quorum ? '' : '（人数不足）'}</div>`;
  const btns = open
    ? `<div class="lg-actions">
        <button class="btn ${mine === 'yes' ? '' : 'ghost'}" data-gv-yes="${esc(v.id)}">同意</button>
        <button class="btn ${mine === 'no' ? '' : 'ghost'}" data-gv-no="${esc(v.id)}">反对</button>
        <button class="btn ghost" data-gv-report="${esc(v.id)}">举报乱发</button>
      </div>`
    : '';
  return `<div class="lg-vote" data-vote="${esc(v.id)}">
      <div class="lg-vote-top">
        <b>${esc(v.question || typeName)}</b>
        <span class="lg-chip">${typeName}${roleName ? ' · ' + roleName : ''}</span>
        <span class="lg-chip ${open ? '' : v.status === 'pass' ? '' : 'warm'}">${statusText}</span>
      </div>
      <div class="sd">${esc(v.byAlias || '成员')} 发起 · 目标是 ${esc(v.targetAlias || (v.target ? '成员' : '全团'))}</div>
      ${bar}
      ${btns}
    </div>`;
}

function govInnerHTML(cache) {
  const G = window.PQLegionGov;
  const c = cache === undefined ? govCache : cache;
  if (!G) return '<h3>团内治理</h3><div class="sd">治理模块没加载成功，重启一下软件。</div>';
  /* 被驱逐：阿刺补一句毒舌（同类 2 分钟内不重复） */
  if (c && c.evicted) alaScold('evict', '驱逐投票通过，7 天申诉期内可提交申诉');
  if (!c) return '<h3>团内治理</h3><div class="sd">正在读成员目录…</div>';
  if (c.error) return '<h3>团内治理</h3><div class="sd">读取失败，稍后自动重试。</div>';

  const self = c.self || {};
  const openVotes = (c.votes || []).filter((v) => v.status === 'open');
  const doneVotes = (c.votes || []).filter((v) => v.status !== 'open');
  const capText = self.isHost ? '团长' : `今天还能发起 ${c.leftToday || 0}/${c.dailyCap || 0} 次`;
  const banLeft = Number(c.bannedUntil) > Date.now() ? ` · 乱发投票禁发起中（约 ${Math.ceil((c.bannedUntil - Date.now()) / 3600e3)} 小时）` : '';
  const canRoleVote = self.isHost || (Array.isArray(self.perms) && self.perms.includes('assign.ask'));
  const typeOpts = Object.keys(G.TYPES)
    .filter((k) => (k === 'role' ? canRoleVote : true))
    .map((k) => `<option value="${k}">${G.TYPES[k].name}</option>`)
    .join('');
  const roleOpts = G.ROLE_LIST.map((r) => `<option value="${r.id}">${r.icon} ${r.name}</option>`).join('');
  const held = c.roles || {};
  /* 一人一职：已经有职务的人不再出现在候选人里 */
  const candidates = G.candidates(Array.isArray(c.roster) ? c.roster : [])
    .filter((m) => !held[m.uid])
    .map((m) => `<option value="${esc(m.uid)}" data-alias="${esc(m.alias)}">${esc(m.alias)}（${G.tierOf(m.credit).name}）</option>`)
    .join('');

  return `
    <h3>团内治理 <span class="sd" style="font-weight:400">· ${capText}${banLeft}</span></h3>
    <div class="sd">军团里只看得到「信誉等级」，看不到具体分数。投票是所有人在同一份规则下算出的同一个结果，没有暗箱。</div>

    ${govRepRankHTML(c)}

    ${govElectionHTML(c)}

    ${govCollectiveHTML(c)}
    ${govSandboxHTML(c)}
    ${
      c.evicted
        ? `<div class="sd" style="margin-top:10px;color:#c0392b">⚖️ 你已被驱逐。${Date.now() < Number(c.evicted.until || 0) ? '7 天申诉期内，可在下方提交申诉。' : '申诉期已过。'}</div>${
            Date.now() < Number(c.evicted.until || 0) && (!c.myAppeal || c.myAppeal.status === 'none')
              ? `<div class="lg-fields" style="margin-top:8px">
                   <textarea class="input" id="gv-appeal-ev" rows="3" maxlength="300" placeholder="申诉证据：写清楚情况（至少 10 个字），申诉成功恢复身份，发起驱逐的团长扣 50 信誉"></textarea>
                   <button class="btn" id="gv-appeal">提交申诉</button>
                 </div>`
              : c.myAppeal && c.myAppeal.status === 'submitted'
                ? '<div class="sd">📨 申诉已提交，等团长（客服）核对证据。</div>'
                : ''
          }`
        : ''
    }
    ${c.abuse ? `<div class="sd" style="margin-top:6px">⚠️ 团长滥用管制 ${c.abuse}/${G.LIMITS.ABUSE_MAX} 次（管制被 3 人否决 / 申诉成功都算），到 3 次自动解除团长职务。</div>` : ''}

    <div class="lg-form-t" style="margin-top:14px">团内成员</div>
    <div class="lg-rows">${govRosterRows(c)}</div>

    <div class="lg-form-t" style="margin-top:18px">进行中的投票（${openVotes.length}）</div>
    <div class="lg-votes">${openVotes.length ? openVotes.map((v) => govVoteCard(v, c)).join('') : '<div class="sd">没有正在进行的投票。</div>'}</div>
    <div class="lg-actions" style="margin-top:8px"><button class="btn ghost" id="gv-toggle">发起投票</button></div>
    <div id="gv-form" style="display:none;margin-top:10px">
      <div class="lg-fields">
        <select class="input" id="gv-type">${typeOpts}</select>
        <input class="input" id="gv-q" maxlength="120" placeholder="要大家表态的事（最多 120 字）" />
      </div>
      <div class="lg-fields" id="gv-role-row" style="display:none">
        <select class="input" id="gv-target">${candidates || '<option value="">没有可任命的人（一人一职，已有职务的先撤销）</option>'}</select>
        <select class="input" id="gv-role">${roleOpts}</select>
      </div>
      <div class="lg-actions"><button class="btn" id="gv-submit">提交投票（开 10 分钟）</button></div>
      <div class="sd">任命只走投票，团长也不能直接任命；每人同时最多一个职务。通过条件：至少 ${G.LIMITS.MIN_PARTICIPANTS} 人参与、在线成员过半、同意率 ≥ ${Math.round(G.LIMITS.PASS_RATIO * 100)}% 且同意多于反对。被 3 个人举报乱发会直接作废，并禁发起 24 小时。</div>
    </div>

    <div class="lg-form-t" style="margin-top:18px">已结束（${doneVotes.length}）</div>
    <div class="lg-votes">${doneVotes.length ? doneVotes.slice(0, 6).map((v) => govVoteCard(v, c)).join('') : '<div class="sd">还没有已结束的投票。</div>'}</div>

    <div class="lg-form-t" style="margin-top:18px">职务能做什么</div>
    <div class="lg-rows">${G.ROLE_LIST.map((r) => `<div class="lg-row"><div class="lg-row-main"><b>${r.icon} ${r.name}</b> <span class="sd">${r.desc}</span></div></div>`).join('')}</div>
    <div class="sd" style="margin-top:8px">职务只给流程上的权限（发起/裁定投票、禁言、看审计），不能换信誉分，也不能改别人的分。任命规则：只走投票、一人一职，谁都不能直接任命——团长也不行；副团长有「提议任命职务」权限，同样只能发起投票。</div>
  `;
}

function paintGov() {
  const box = $('#lg-gov');
  if (!box) return;
  box.innerHTML = govInnerHTML();
  bindGovControls();
}

/* 集体任务卡：团长发起 / 成员汇报 / 达成全团加成 + 解锁 L2 狂欢档 */
function govCollectiveHTML(c) {
  const col = c.collective;
  const isHost = c.self && c.self.isHost;
  if (!col || col.status !== 'done') {
    const prog = col ? Number(col.progress) || 0 : 0;
    const target = col ? Number(col.target) || 90 : 90;
    return `
      <div class="lg-form-t" style="margin-top:14px">集体任务（达成全团 +20 分，并解锁 L2 狂欢档）</div>
      ${
        col
          ? `<div class="lg-row"><div class="lg-row-main">
              <b>${esc(col.title)}</b> <span class="sd">基线 ${target}% · 发起日 ${esc(col.day)}</span>
              <div class="lg-row-sub"><div style="background:var(--line);height:8px;border-radius:4px;overflow:hidden"><div style="width:${Math.min(100, prog)}%;height:100%;background:linear-gradient(90deg,#ff9d5c,#ff6b81)"></div></div>
              <span class="sd">当前出操率 ${prog}% / 基线 ${target}%</span></div>
            </div>
            <div class="lg-row-ops"><button class="btn small" id="gv-col-report">我完成了（汇报贡献）</button></div></div>`
          : `<div class="sd">还没有集体任务。${isHost ? '团长在下方发起；其他成员可发起「其他事项」投票推动。' : '等团长发起，或发起投票推动。'}</div>`
      }
      ${
        isHost
          ? `<div class="lg-fields" style="margin-top:8px">
              <input class="input" id="gv-col-title" maxlength="40" placeholder="集体任务名（如：全员出操）" />
              <select class="input" id="gv-col-target">
                ${[60, 70, 80, 90, 100].map((x) => `<option value="${x}" ${x === 90 ? 'selected' : ''}>基线 ${x}%</option>`).join('')}
              </select>
              <button class="btn" id="gv-col-set">发起</button>
            </div>`
          : ''
      }
    `;
  }
  return `
    <div class="lg-form-t" style="margin-top:14px">集体任务</div>
    <div class="lg-row"><div class="lg-row-main">
      <b>✅ ${esc(col.title)}</b> <span class="sd">已达成（${Number(col.progress) || 0}%）· 全团 +20 分已发，频道解锁 L2 狂欢档</span>
    </div></div>
  `;
}

/* 沙箱卡：收到别人的计划包后，24 小时内转正或删除 */
function govSandboxHTML(c) {
  const sb = c.sandbox;
  if (!sb || !sb.present) return '';
  return `
    <div class="lg-form-t" style="margin-top:14px">📦 沙箱里的计划包（24 小时）</div>
    <div class="lg-row"><div class="lg-row-main">
      <b>${esc((sb.src && sb.src.fromAlias) || '来源不明')}</b> <span class="sd">${esc(sb.sourceText || '')} · 剩 ${esc(sb.leftText || '')}</span>
      <div class="lg-row-sub">积分变动和契约执行都是虚拟的，转正才落到主计划。</div>
    </div>
    <div class="lg-row-ops">
      <button class="btn small" id="gv-sb-promote">转正</button>
      <button class="btn small ghost" id="gv-sb-drop">删除</button>
    </div></div>
  `;
}

async function refreshGov() {
  let st = null;
  let ls = null;
  try {
    st = await api.govState();
  } catch (_) {}
  try {
    ls = await api.legionStatus();
  } catch (_) {}
  const mesh = window.PQLegionMesh && PQLegionMesh.info ? PQLegionMesh.info() : null;
  let roster = [];
  if (mesh && Array.isArray(mesh.roster) && mesh.roster.length) {
    roster = mesh.roster.map((m) => ({ uid: m.uid, alias: m.alias, credit: m.credit }));
  } else if (ls && Array.isArray(ls.members)) {
    roster = ls.members.map((m) => ({ uid: m.uid, alias: m.alias, credit: m.uid === st?.self?.uid ? st?.self?.credit : null, self: m.self, online: m.online }));
  }
  if (!roster.length && st && st.self && st.self.uid) {
    roster = [{ uid: st.self.uid, alias: st.self.alias, credit: st.self.credit, self: true, online: true }];
  }
  govCache = st ? { ...st, roster } : { error: true, roster };
  /* 沙箱状态 / 闲聊档位：给频道折叠与沙箱卡用 */
  try {
    const sb = await api.planSandbox();
    if (govCache) govCache.sandbox = sb;
  } catch (_) {}
  window.__pqTier = (st && st.tier) || null;
  paintGov();
}

/* 团长退团流程：先在频道公告，异地再发起接任选举，然后才真正退出。
   局域网军团依附团长的电脑，退团即解散，所以只发解散公告。 */
async function govLeaveFlow() {
  try {
    const st = await api.govState();
    const self = st && st.self;
    if (!self || !self.isHost || !self.joined) return;
    const M = window.PQLegionMesh;
    const meshInfo = M && typeof M.info === 'function' ? M.info() : null;
    const p2p = !!(meshInfo && meshInfo.mounted);
    const r = await api.govAnnounceLeave({ p2p });
    if (!r || !r.ok || !r.election) return;
    const ch = window.PQLegionChannel;
    if (p2p && ch) {
      const alias = self.alias || '团长';
      ch.meshBroadcast({
        t: 'gve',
        kind: 'election',
        election: r.election,
        notice: `📢 团长「${alias}」已退团。团长选举已开始，10 分钟后结算：在治理面板参选或投票，票多者接任。`,
      });
      ch.sys(`📢 团长「${alias}」已退团。团长选举已开始，10 分钟后结算。`);
      /* 给网格一点时间把帧发出去，再断开连接 */
      await new Promise((res) => setTimeout(res, 300));
    }
  } catch (_) {}
}

function bindGovControls() {
  /* ---- 团长选举帧：别人的参选 / 投票 / 选举公告落到本地账上 ---- */
  const C = window.PQLegionChannel;
  if (C && typeof C.onGov === 'function') {
    C.onGov(async (f) => {
      if (!f) return;
      try {
        if (f.kind === 'seed') await api.govElectionApply({ kind: 'seed', election: f.election });
        else if (f.kind === 'candidacy') await api.govElectionApply({ kind: 'candidacy', uid: f.uid, alias: f.alias, credit: f.credit });
        else if (f.kind === 'ballot') await api.govElectionApply({ kind: 'ballot', voter: f.voter, choice: f.choice });
      } catch (_) {}
      if (currentView === 'legion') refreshGov();
    });
  }

  /* ---- 选举动作：参选 / 投票 / 重新发起（异地网格广播，局域网只记账） ---- */
  const gBroadcast = (obj) => {
    if (window.PQLegionChannel && typeof window.PQLegionChannel.meshBroadcast === 'function') {
      window.PQLegionChannel.meshBroadcast(obj);
    }
  };

  const elCamp = $('#gv-el-campaign');
  if (elCamp)
    elCamp.onclick = async () => {
      elCamp.disabled = true;
      const r = await api.govCampaign();
      elCamp.disabled = false;
      if (!r || !r.ok) {
        toast('没能参选', (r && r.message) || '', true);
        return;
      }
      const me = govCache.self || {};
      gBroadcast({
        t: 'gve',
        kind: 'candidacy',
        uid: me.uid,
        alias: me.alias,
        credit: me.credit,
        notice: `🙋 「${me.alias || '成员'}」参选团长`,
      });
      await refreshGov();
    };

  document.querySelectorAll('[data-gv-el-vote]').forEach((b) => {
    b.onclick = async () => {
      const choice = b.getAttribute('data-gv-el-vote');
      const ok2 = await confirmDialog('把票投给这位候选人？', '一人一票，改票只留最后一次；10 分钟后结算，票多者接任团长。');
      if (!ok2) return;
      const r = await api.govBallot({ choice });
      if (!r || !r.ok) {
        toast('没投上', (r && r.message) || '', true);
        return;
      }
      gBroadcast({ t: 'gve', kind: 'ballot', from: (govCache.self || {}).uid || '', choice });
      toast('已投票', '结算后全员算出同一个新团长');
      await refreshGov();
    };
  });

  const elRestart = $('#gv-el-restart');
  if (elRestart)
    elRestart.onclick = async () => {
      elRestart.disabled = true;
      const r = await api.govAnnounceElection();
      elRestart.disabled = false;
      if (!r || !r.ok) {
        toast('没能发起', (r && r.message) || '', true);
        return;
      }
      const alias = (govCache.self || {}).alias || '成员';
      gBroadcast({
        t: 'gve',
        kind: 'election',
        election: r.election,
        notice: `📢 团长选举已由「${alias}」重新发起，10 分钟后结算：在治理面板参选或投票。`,
      });
      if (window.PQLegionChannel) window.PQLegionChannel.sys(`📢 团长选举已重新发起，10 分钟后结算。`);
      await refreshGov();
    };

  /* 成员目录上的两个动作：点名 / 邀进房间 */
  document.querySelectorAll('[data-gvat]').forEach((b) => {
    b.onclick = () => mentionInChannel(b.getAttribute('data-alias'));
  });
  document.querySelectorAll('[data-gvroom]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      const alias = b.getAttribute('data-alias');
      await inviteLegionMateToRoom(alias);
      b.disabled = false;
    };
  });
  const tog = $('#gv-toggle');
  if (tog)
    tog.onclick = () => {
      const f = $('#gv-form');
      if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
    };
  const type = $('#gv-type');
  if (type)
    type.onchange = () => {
      const row = $('#gv-role-row');
      if (row) row.style.display = type.value === 'role' ? 'flex' : 'none';
    };

  const submit = $('#gv-submit');
  if (submit)
    submit.onclick = async () => {
      const t = ($('#gv-type') || {}).value || 'other';
      const q = (($('#gv-q') || {}).value || '').trim();
      const payload = { type: t, question: q };
      if (t === 'role') {
        const sel = $('#gv-target');
        const opt = sel && sel.selectedOptions && sel.selectedOptions[0];
        payload.target = sel ? sel.value : '';
        payload.targetAlias = opt ? opt.getAttribute('data-alias') || opt.textContent.split('（')[0] : '';
        payload.role = ($('#gv-role') || {}).value || '';
        if (!payload.question) payload.question = `任命 ${payload.targetAlias} 为职务`;
      }
      if (!payload.question) {
        toast('写一句要大家表态的事', '一句话就够', true);
        return;
      }
      /* L2 社交特权：纪律官 / 仲裁员要裁定别人的争议，信誉得先站得住（≥100） */
      if (t === 'role' && (payload.role === 'judge' || payload.role === 'arbiter')) {
        const m = ((govCache && govCache.roster) || []).find((x) => String(x.uid) === String(payload.target));
        const sc2 = m ? Number(m.credit) : NaN;
        if (Number.isFinite(sc2) && sc2 < 100) {
          toast(
            '这个人暂时不合适',
            `${payload.targetAlias || '他'}信誉 ${Math.round(sc2)} 分，裁定类职务要 L2（≥100 分）——先把自己那份打卡补上再来裁别人`,
            true
          );
          return;
        }
      }
      submit.disabled = true;
      const r = await api.govCreate(payload);
      submit.disabled = false;
      if (!r || !r.ok) {
        toast('没能发起', (r && r.message) || '稍后再试', true);
        return;
      }
      toast('投票已发起', '10 分钟内有效，大家都能看到');
      await refreshGov();
    };

  document.querySelectorAll('[data-gv-yes],[data-gv-no]').forEach((b) => {
    b.onclick = async () => {
      const id = b.getAttribute('data-gv-yes') || b.getAttribute('data-gv-no');
      const choice = b.hasAttribute('data-gv-yes') ? 'yes' : 'no';
      const r = await api.govCast({ id, choice });
      if (!r || !r.ok) toast('没投上', (r && r.message) || '', true);
      await refreshGov();
    };
  });

  document.querySelectorAll('[data-gv-report]').forEach((b) => {
    b.onclick = async () => {
      const id = b.getAttribute('data-gv-report');
      const ok = await confirmDialog('举报这个投票？', '3 个不同的人举报，这个投票会作废，发起人 24 小时不能再发起，并扣信誉分。恶意举报同样会被记账。');
      if (!ok) return;
      const r = await api.govReport({ id });
      if (!r || !r.ok) toast('举报没提交', (r && r.message) || '', true);
      else toast(r.voided ? '已作废' : '已记一票举报', r.voided ? '这个投票被集体否决了' : '再有 2 个人举报就会作废');
      await refreshGov();
    };
  });

  /* ---- 集体任务：发起 / 汇报贡献 ---- */
  const colSet = $('#gv-col-set');
  if (colSet) {
    colSet.onclick = async () => {
      const title = ($('#gv-col-title') || {}).value || '';
      const target = Number(($('#gv-col-target') || {}).value) || 90;
      const r = await api.govCollectiveSet({ title, target });
      toast(r && r.ok ? '集体任务已发起' : '没发起来', (r && r.message) || '', !(r && r.ok));
      await refreshGov();
    };
  }
  const colReport = $('#gv-col-report');
  if (colReport) {
    colReport.onclick = async () => {
      const r = await api.govCollectiveProgress({ pct: 1 });
      if (r && r.ok) toast(r.met ? '集体任务达成！' : '已记贡献', r.met ? '全团 +20 分，频道解锁狂欢档' : `当前出操率 ${r.progress}%`);
      else toast('没记上', (r && r.message) || '', true);
      await refreshGov();
    };
  }

  /* ---- 沙箱：转正 / 删除 ---- */
  const sbPromote = $('#gv-sb-promote');
  if (sbPromote) {
    sbPromote.onclick = async () => {
      const r = await api.planSandboxPromote();
      toast(r && r.ok ? '已转正' : '没转成', (r && r.message) || '', !(r && r.ok));
      await refreshGov();
    };
  }
  const sbDrop = $('#gv-sb-drop');
  if (sbDrop) {
    sbDrop.onclick = async () => {
      const r = await api.planSandboxDrop();
      toast('沙箱已清空', (r && r.message) || '');
      await refreshGov();
    };
  }

  /* ---- Lv1 劝导 / Lv2 管制 / Lv3 驱逐 / 黑名单 ---- */
  document.querySelectorAll('[data-gvfold]').forEach((b) => {
    b.onclick = async () => {
      const uid = b.getAttribute('data-gvfold');
      const alias = b.getAttribute('data-alias') || '成员';
      const r = await api.govFold({ uid, alias });
      if (r && r.ok) toast('已提醒', r.watch ? `${alias} 已被提醒 ${r.count} 次，进入观察名单` : `${alias} 收到私信提醒（第 ${r.count} 次）`);
      else toast('没提醒成', (r && r.message) || '', true);
      await refreshGov();
    };
  });
  document.querySelectorAll('[data-gvmod]').forEach((b) => {
    b.onclick = async () => {
      const uid = b.getAttribute('data-gvmod');
      const alias = b.getAttribute('data-alias') || '成员';
      const reason = prompt(`管制 ${alias}：必须填理由（会记进军团日志，全员可查）`, '频繁发送无关链接');
      if (!reason || reason.trim().length < 4) return toast('理由太短', '至少 4 个字，写清楚为什么管制', true);
      const minutes = Number(prompt('禁言多久（分钟）：1 / 360 / 1440', '60')) || 60;
      const r = await api.govModerateStart({ uid, alias, reason, minutes });
      if (r && r.ok) toast('管制投票已发起', '副团长投票过半才生效');
      else toast('没发起来', (r && r.message) || '', true);
      await refreshGov();
    };
  });
  document.querySelectorAll('[data-gvevict]').forEach((b) => {
    b.onclick = async () => {
      const uid = b.getAttribute('data-gvevict');
      const alias = b.getAttribute('data-alias') || '成员';
      const reason = prompt(`驱逐提案 ${alias}：必须填理由`, '长期不打卡且扰乱频道');
      if (!reason || reason.trim().length < 4) return toast('理由太短', '至少 4 个字', true);
      const ok = await confirmDialog('发起驱逐提案？', `全体成员 24 小时内投票，赞成超过 2/3 才执行；${alias} 有 7 天申诉期，申诉成功你扣 50 信誉。`);
      if (!ok) return;
      const r = await api.govEvictStart({ uid, alias, reason });
      if (r && r.ok) toast('驱逐提案已发起', '24 小时投票，赞成 >2/3 执行');
      else toast('没发起来', (r && r.message) || '', true);
      await refreshGov();
    };
  });
  document.querySelectorAll('[data-gvban]').forEach((b) => {
    b.onclick = async () => {
      const uid = b.getAttribute('data-gvban');
      const alias = b.getAttribute('data-alias') || '成员';
      const ok = await confirmDialog('拉黑计划文件？', `此后 ${alias} 发的任何 .pqplan 都会被自动拦截，接收方连预览都看不到。`);
      if (!ok) return;
      const r = await api.planBanToggle({ uid, on: true });
      if (r && r.ok) toast('已拉黑', `${alias} 的计划包以后直接拦截`);
      else toast('没拉黑成', (r && r.message) || '', true);
      await refreshGov();
    };
  });

  /* ---- 被驱逐：7 天申诉 ---- */
  const appealBtn = $('#gv-appeal');
  if (appealBtn) {
    appealBtn.onclick = async () => {
      const evidence = ($('#gv-appeal-ev') || {}).value || '';
      if (evidence.trim().length < 10) return toast('证据太少', '把情况写清楚（至少 10 个字）', true);
      const r = await api.govAppeal({ evidence });
      if (r && r.ok) {
        toast(r.won ? '申诉成功' : '申诉失败', r.won ? '恢复成员身份；发起驱逐的团长扣 50 信誉' : `赞成率 ${Math.round((r.yesRatio || 0) * 100)}%，团内异议不足`);
      } else toast('申诉没提交', (r && r.message) || '', true);
      await refreshGov();
    };
  }
}

function bindLegionPanel(L) {
  refreshGov();
  const sel = $('#lg-interval');
  if (sel)
    sel.onchange = () => {
      const h = PQLegion.setIntervalH(Number(sel.value) || 4);
      toast('同步间隔已改', `每 ${h} 小时一次`);
    };

  const pause = $('#lg-pause');
  if (pause)
    pause.onclick = () => {
      const onNow = PQLegion.setPaused(!L.paused);
      toast(onNow ? '已暂停同步' : '已恢复同步', onNow ? '不会再往外发任何数据' : '下次到点自动同步');
    };

  const sync = $('#lg-sync');
  if (sync)
    sync.onclick = async () => {
      sync.disabled = true;
      const r = await PQLegion.syncNow({ force: true });
      sync.disabled = false;
      if (r.ok) toast('同步完成', '军团士气已更新');
      else toast('同步没成功', r.message || '', true);
    };

  const lamp = $('#lg-lamp');
  if (lamp)
    lamp.onclick = async () => {
      const r = await PQLegion.lamp();
      if (!r.ok) return toast('没点上', r.message || '', true);
      const left = typeof r.left === 'number' ? `今天还能点 ${r.left} 盏` : '匿名互助';
      toast('灯已点亮（-5 分）', left);
      render(false);
    };

  const claim = $('#lg-claim');
  if (claim)
    claim.onclick = async () => {
      const r = await PQLegion.claimLamp();
      if (!r.ok) return toast('没领到', r.message || '', true);
      toast('领到一盏灯（+5 分）', '先从坑里爬出来一点');
      render(false);
    };

  const mute = $('#lg-mute');
  if (mute)
    mute.onclick = async () => {
      const next = !L.muted;
      await PQLegion.setMuted(next);
      toast(next ? '熔断已开' : '熔断已关', next ? '集体挑战与徽章暂停发放' : '恢复自动挑战');
    };

  const leave = $('#lg-leave');
  if (leave)
    leave.onclick = async () => {
      const ok2 = await confirmDialog('退出军团？', '退出后本机不再向任何人发送数据。房主的军团仍然存在。');
      if (!ok2) return;
      await govLeaveFlow(); // 团长退团：先公告 + 发起接任选举，再退出
      PQLegion.leave();
      toast('已退出军团');
      render(false);
    };

  /* 异地房主：生成邀请码 / 粘贴回执码 */
  const inv = $('#lg-invite');
  if (inv)
    inv.onclick = async () => {
      const box = $('#lg-invite-box');
      if (box) box.hidden = false;
      const N = window.PQLegionNet;
      if (!N) return;
      const r = await N.invite();
      const t = $('#lg-invite-text');
      if (t) t.textContent = r.ok ? r.text : (r.message || '生成失败');
      const cp = $('#lg-copy-invite');
      if (cp)
        cp.onclick = () => {
          if (!r.ok) return;
          copyText(r.text);
          toast('已复制邀请码', '用微信发给对方');
        };
    };

  const replyGo = $('#lg-reply-go');
  if (replyGo)
    replyGo.onclick = async () => {
      const N = window.PQLegionNet;
      if (!N) return;
      const text = ($('#lg-reply-in')?.value || '').trim();
      if (!text) return toast('还没粘贴回执码', '', true);
      replyGo.disabled = true;
      const r = await N.applyReply(text);
      replyGo.disabled = false;
      if (!r.ok) return toast('配对没成功', r.message || '', true);
      toast('配对成功', '对方上线后就会开始同步');
      render(false);
    };

  /* 异地成员：重新配对 */
  const repair = $('#lg-repair');
  if (repair)
    repair.onclick = async () => {
      const ok3 = await confirmDialog('重新配对？', '会断开当前的异地连接，需要房主再发一次邀请码。');
      if (!ok3) return;
      PQLegion.leave();
      render(false);
    };

  bindDiscPanel();
}

/* ================= 外壳 ================= */

/* ---------------- 好友区（F0 未结缘 / F1 搭子档 / F2 战友档） ----------------
 * 不能搜陌生人私信；结缘只走三条路：双人自习室 / 对赌契约 / 问答申请。
 * 私聊纯文本+软件内链接，24h 焚毁；双方今日完成率 ≥50% 才能发。
 */
let friendCache = null;
let friendChatUid = '';

async function friendRefresh() {
  try {
    friendCache = await api.friendState();
  } catch (_) {
    friendCache = null;
  }
  if (friendChatUid && friendCache && friendCache.friends[friendChatUid]) {
    try {
      const ms = await api.friendMsgs(friendChatUid);
      friendCache.chatMsgs = (ms && ms.msgs) || [];
    } catch (_) {
      friendCache.chatMsgs = [];
    }
  } else if (friendCache) friendCache.chatMsgs = [];
  if (currentView === 'friends') renderFriends();
}

function friendTierBadge(tier) {
  return tier === 2 ? '<span class="fb-tier t2">战友档 F2</span>' : '<span class="fb-tier t1">搭子档 F1</span>';
}

function friendViaText(via) {
  return { room: '双人自习室', contract: '对赌契约', gate: '问答申请' }[via] || '软件内认识';
}

function friendPactHTML(f, myRate) {
  const p = f.pact;
  if (p && p.status === 'active') {
    const total = Number(p.days) || 0;
    const missed = Number(p.missed) || 0;
    const doneDays = (p.log || []).filter((x) => x && x.done).length;
    const per = Math.ceil((Number(p.deposit) || 0) / Math.max(1, total));
    return `<div class="fb-pact">
      <div class="sd">📜 互相契约生效中 · 押金 <b>${p.deposit}</b> 分 · ${p.startDay} → ${p.endDay}（${total} 天）</div>
      <div class="sd">全勤 ${doneDays} 天 · 漏卡 <b>${missed}</b> 天（漏一天扣 ${per} 分，全勤到期全退）</div>
      <button class="btn small ghost" id="fb-pact-settle" style="margin-top:6px">提前结算</button>
    </div>`;
  }
  if (p && p.status === 'done') {
    return `<div class="fb-pact"><div class="sd">📜 上一次契约已结束（漏 ${p.missed} 天）。可以立一份新的。</div></div>`;
  }
  return `<div class="fb-pact">
    <div class="sd">📜 互相契约：双方各押一笔积分，断勤按天扣，全勤到期全退。每晚 21 点后你没打完的卡会自动提醒对方。</div>
    <div class="lg-fields" style="margin-top:6px">
      <input class="input" id="fb-pact-deposit" type="number" min="5" max="200" placeholder="押金（5~200 分）" />
      <input class="input" id="fb-pact-days" type="number" min="3" max="30" placeholder="天数（3~30）" />
      <button class="btn small" id="fb-pact-new">立契约</button>
    </div>
  </div>`;
}

function friendRankHTML() {
  const R = window.PQFriend;
  if (!R || !friendCache) return '';
  const rows = friendCache.rank && friendCache.rank.rows ? friendCache.rank.rows : R.ranking(friendCache.friends || {}, friendCache.rates ? friendCache.rates.my : 0, '我');
  const medal = (r) => (r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `${r.rank}.`);
  return rows
    .map(
      (r) => `<div class="fb-rank-row${r.isMe ? ' me' : ''}">
        <span class="fb-rank-medal">${medal(r)}</span>
        <span class="fb-rank-name">${esc(r.alias)}${r.isMe ? '（我）' : ''} ${friendTierBadge(r.tier)}</span>
        <span class="fb-rank-bar"><i style="width:${r.rate}%"></i></span>
        <span class="fb-rank-rate">${r.rate}%</span>
      </div>`
    )
    .join('');
}

function renderFriends() {
  const el = $('#view');
  if (!el) return;
  const st = friendCache || { friends: {}, gates: {}, rates: { my: 0 } };
  const L = (st.limits || {});
  const my = st.rates ? st.rates.my : 0;
  const uids = Object.keys(st.friends || {});
  const gateIds = Object.keys(st.gates || {});
  const chatUid = friendChatUid && st.friends[friendChatUid] ? friendChatUid : '';
  const f = chatUid ? st.friends[chatUid] : null;
  const quota = f ? window.PQFriend.quotaLeft(f, Date.now(), true) : 0;
  const cap = f && Number(f.tier) === 2 ? L.F2_DAILY || 50 : L.F1_DAILY || 20;
  const gateMsg = f ? window.PQFriend.canSend(f, Date.now(), { kind: 'text', myRate: my, peerRate: Number(f.peerRate) || 0 }) : null;

  const friendRows = uids
    .map((uid) => {
      const x = st.friends[uid];
      const pr = Number(x.peerRate) || 0;
      return `<div class="fb-row${uid === chatUid ? ' active' : ''}" data-fbuid="${esc(uid)}">
        <div class="fb-row-main">
          <b>${esc(x.alias || '搭子')}</b> ${friendTierBadge(Number(x.tier) || 1)}
          <span class="sd">${esc(friendViaText(x.via))} · 对方完成率 ${pr}%</span>
        </div>
        <div class="fb-row-ops">
          <button class="btn small ghost" data-fbrate="${esc(uid)}" title="记对方报的今日完成率（TA 在聊天/同房时说的）">记完成率</button>
          <button class="btn small" data-fbchat="${esc(uid)}">私聊</button>
        </div>
      </div>`;
    })
    .join('');

  const gateRows = gateIds
    .map((uid) => {
      const g = st.gates[uid];
      if (g.status !== 'open') return '';
      const qs = (g.questions || [])
        .map((q, i) => `<div class="fb-q"><span class="sd">Q${i + 1}. ${esc(q.q)}</span><input class="input" data-gatea="${esc(uid)}|${i}" maxlength="60" placeholder="你的回答" /></div>`)
        .join('');
      return `<div class="fb-row">
        <div class="fb-row-main"><b>${esc(g.alias || uid)}</b> <span class="sd">发来的问答申请（${(g.questions || []).length} 题）</span></div>
        <div class="fb-gate">${qs}<button class="btn small" data-gatesubmit="${esc(uid)}">提交答案</button></div>
      </div>`;
    })
    .filter(Boolean)
    .join('');

  const chatHTML = f
    ? `<div class="panel" id="fb-chat">
        <h3>和 ${esc(f.alias || '搭子')} 的私聊 <span class="sd">· ${Number(f.tier) === 2 ? '战友档' : '搭子档'} · ${quota}/${cap} 条今日额度 · 消息 24h 焚毁</span></h3>
        ${friendTierBadge(Number(f.tier) || 1)} <span class="sd">${esc((window.PQFriend.TIERS && window.PQFriend.TIERS[Number(f.tier)] || {}).desc || '')}</span>
        ${
          gateMsg && !gateMsg.ok
            ? `<div class="sd" style="margin-top:8px;color:#c0392b">🚫 ${esc(gateMsg.reason)}</div>`
            : `<div class="sd" style="margin-top:8px">✅ 可以发：纯文本${Number(f.tier) === 2 ? ' + 打卡截图 + 计划包（二次确认）' : ' + 软件<em>内</em>链接'}。禁图片/文件/外部链接，防微商入口。</div>`
        }
        ${friendPactHTML(f, my)}
        <div class="fb-log" id="fb-log">
          ${(st.chatMsgs || [])
            .map((m) => {
              const left = window.PQFriend.burnLeft(m, Date.now());
              const h = Math.max(0, Math.floor(left / 3600e3));
              const min = Math.max(0, Math.floor((left % 3600e3) / 60e3));
              const remind = m.kind === 'remind';
              /* 好友私聊里的 pq:// 链接（尤其 PK 挑战券）也渲染成可点按钮 */
              const fblib = window.PQLegionChat;
              const bodyHtml = fblib && fblib.splitLinks
                ? fblib.splitLinks(m.text || '').map((seg) => {
                    if (!seg.link) return esc(seg.text);
                    if (seg.link.kind === 'pk') {
                      return `<button class="btn small pk-challenge" data-pk="${esc(encodeURIComponent(JSON.stringify(seg.link)))}">⚔️ 应战 ${esc(seg.link.name)}（战力 ${Number(seg.link.rate) || 0}）</button>`;
                    }
                    return esc(seg.text); // 好友区不解析 room/legion 链接，避免误入
                  }).join('')
                : esc(m.text || '');
              return `<div class="fb-msg${remind ? ' remind' : ''}"><span class="sd">${remind ? '🤖 自动提醒' : '🔥'} ${h}h${min}m 后焚毁</span><div>${bodyHtml}</div></div>`;
            })
            .join('') || '<div class="sd">还没聊过。说第一句（先各自把完成率干到 50%）。</div>'}
        </div>
        <div class="lg-fields" style="margin-top:8px">
          <input class="input" id="fb-text" maxlength="200" placeholder="${gateMsg && !gateMsg.ok ? esc(gateMsg.reason) : '说点正事（纯文本）'}" ${gateMsg && !gateMsg.ok ? 'disabled' : ''} />
          <button class="btn" id="fb-send" ${gateMsg && !gateMsg.ok ? 'disabled' : ''}>发</button>
          ${
            Number(f.tier) === 2
              ? `<button class="btn small ghost" id="fb-shot" ${gateMsg && !gateMsg.ok ? 'disabled' : ''} title="打卡截图互证（F2）">📸 截图</button>
                 <button class="btn small ghost" id="fb-plan" ${gateMsg && !gateMsg.ok ? 'disabled' : ''} title="转发计划包（F2，对方二次确认+沙箱）">📋 计划包</button>`
              : ''
          }
        </div>
      </div>`
    : '';

  el.innerHTML = `
    <h2>🤝 好友区</h2>
    <div class="panel">
      <h3>结缘规则 <span class="sd">· 我今日完成率 ${my}%</span></h3>
      <div class="sd">不能搜陌生人私信——防约炮防微商。结缘只走三条正路：<b>双人自习室</b>（同房打卡过）、<b>对赌契约</b>（互为监督人）、<b>问答申请</b>（答对方出的问题）。私聊双方今日完成率 ≥${L.RATE_GATE || 50}% 才能发，两边都摆烂输入框直接灰掉。</div>
      <div class="lg-fields" style="margin-top:8px">
        <input class="input" id="fb-new-uid" maxlength="40" placeholder="对方 ID（同房/契约名单里能看到）" />
        <input class="input" id="fb-new-alias" maxlength="16" placeholder="对方昵称" />
        <select class="input" id="fb-new-via">
          <option value="room">双人自习室认识</option>
          <option value="contract">对赌契约认识</option>
          <option value="gate">问答申请认识</option>
        </select>
        <button class="btn" id="fb-bond">结缘</button>
      </div>
      <div class="lg-fields" style="margin-top:8px">
        <input class="input" id="fb-gq" maxlength="60" placeholder="问 TA 一个问题（如：你为什么想和我组队打卡？）" />
        <button class="btn ghost" id="fb-gate-new">发问答申请</button>
        <span class="sd">对方答完自动结缘；${L.GATE_MIN || 1}~${L.GATE_MAX || 5} 题。</span>
      </div>
    </div>
    <div class="panel">
      <h3>待处理申请 <span class="sd">· ${gateRows ? gateIds.length + ' 条' : '没有'}</span></h3>
      ${gateRows || '<div class="sd">没有人给你出题。先去自习房和契约里认识人。</div>'}
    </div>
    <div class="panel">
      <h3>任务排行 <span class="sd">· 按今日完成率 · 我完成率 ${my}% · 平分按昵称序</span></h3>
      <div class="fb-rank">${friendRankHTML()}</div>
    </div>
    <div class="panel">
      <h3>我的搭子 <span class="sd">· ${uids.length}/${L.MAX_FRIENDS || 20} 人 · F1→F2 要双方当日全勤，次日升级；断勤退 F1，连续 ${L.SLUMP_LIMIT || 3} 天断勤自动解缘</span></h3>
      ${friendRows || '<div class="sd">还没有搭子。</div>'}
      <div class="lg-fields" style="margin-top:8px"><button class="btn ghost small" id="fb-settle">结算昨日全勤（升级/降档）</button></div>
    </div>
    ${chatHTML}
  `;

  bindFriendControls();
}

function bindFriendControls() {
  const bond = $('#fb-bond');
  if (bond)
    bond.onclick = async () => {
      const uid = ($('#fb-new-uid') || {}).value || '';
      const alias = ($('#fb-new-alias') || {}).value || '';
      const via = ($('#fb-new-via') || {}).value || 'room';
      const r = await api.friendBond({ uid, alias, via });
      toast(r && r.ok ? '已结缘' : '没结成', (r && r.message) || '', !(r && r.ok));
      await friendRefresh();
    };

  const gateNew = $('#fb-gate-new');
  if (gateNew)
    gateNew.onclick = async () => {
      const uid = ($('#fb-new-uid') || {}).value || '';
      const alias = ($('#fb-new-alias') || {}).value || '';
      const q = ($('#fb-gq') || {}).value || '';
      if (!uid || !q) return toast('缺信息', '先填对方 ID 和问题', true);
      const r = await api.friendGateNew({ uid, alias, questions: [{ q, a: '' }] });
      toast(r && r.ok ? '问答申请已发出' : '没发出', (r && r.message) || '', !(r && r.ok));
      await friendRefresh();
    };

  const gateSubmit = $('#view [data-gatesubmit]');
  if (gateSubmit)
    gateSubmit.onclick = async () => {
      const uid = gateSubmit.getAttribute('data-gatesubmit');
      const answers = [];
      document.querySelectorAll(`[data-gatea^="${uid}|"]`).forEach((inp) => {
        const i = Number(String(inp.getAttribute('data-gatea')).split('|')[1]) || 0;
        answers[i] = inp.value || '';
      });
      const r = await api.friendGateAnswer({ uid, answers });
      toast(r && r.ok ? (r.pass ? '通过！已结缘' : '没通过') : '没提交成', (r && r.message) || '', !(r && r.ok && r.pass));
      await friendRefresh();
    };

  const settle = $('#fb-settle');
  if (settle)
    settle.onclick = async () => {
      const r = await api.friendSettle();
      toast(r && r.ok ? '已结算' : '没结成', (r && r.notes || []).join('；') || '昨天没有需要变动的关系', !(r && r.ok));
      await friendRefresh();
    };

  document.querySelectorAll('[data-fbchat]').forEach((b) => {
    b.onclick = () => {
      friendChatUid = b.getAttribute('data-fbchat') || '';
      renderFriends();
    };
  });
  document.querySelectorAll('[data-fbuid]').forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest('button')) return;
      friendChatUid = row.getAttribute('data-fbuid') || '';
      renderFriends();
    };
  });
  document.querySelectorAll('[data-fbrate]').forEach((b) => {
    b.onclick = async () => {
      const uid = b.getAttribute('data-fbrate');
      const v = prompt('对方今日完成率（TA 自己报的，0~100）：', '50');
      const r = await api.friendPeerRate({ uid, rate: Number(v) });
      if (!r || !r.ok) toast('没记上', (r && r.message) || '', true);
      await friendRefresh();
    };
  });

  /* ---- 互相契约：立 / 提前结算 ---- */
  const pactNew = $('#fb-pact-new');
  if (pactNew)
    pactNew.onclick = async () => {
      const deposit = Number(($('#fb-pact-deposit') || {}).value) || 0;
      const days = Number(($('#fb-pact-days') || {}).value) || 7;
      const r = await api.friendPactSet({ uid: friendChatUid, deposit, days });
      toast(r && r.ok ? '契约生效' : '没立成', r && r.ok ? `${deposit} 分押金 · ${days} 天 · 断勤按天扣，全勤全退` : (r && r.message) || '', !(r && r.ok));
      await friendRefresh();
    };
  const pactSettle = $('#fb-pact-settle');
  if (pactSettle)
    pactSettle.onclick = async () => {
      const okNow = await confirmDialog('提前结算这份契约？', '漏掉的天照样按天扣押金，扣完剩下的退回。');
      if (!okNow) return;
      const r = await api.friendPactSettle({ uid: friendChatUid });
      if (r && r.ok) toast(r.pass ? '全勤！押金全退 ✅' : `已结算：漏 ${r.missed} 天，扣 ${r.penalty} 分`, `退回 ${r.refund} 分`);
      else toast('没结成', (r && r.message) || '', true);
      await friendRefresh();
    };

  const send = $('#fb-send');
  if (send)
    send.onclick = async () => {
      const inp = $('#fb-text');
      const text = (inp || {}).value || '';
      if (!text.trim()) return;
      const r = await api.friendSend({ uid: friendChatUid, text, kind: 'text' });
    if (!r || !r.ok) {
      toast('没发出去', (r && r.message) || '', true);
      alaScold('friend', (r && r.message) || '门槛没过');
    }
    if (inp) inp.value = '';
      await friendRefresh();
    };

  const shot = $('#fb-shot');
  if (shot)
    shot.onclick = async () => {
      const r = await api.friendSend({ uid: friendChatUid, text: '📸 打卡截图互证（今日全勤）', kind: 'shot' });
      if (!r || !r.ok) {
        toast('没发出去', (r && r.message) || '', true);
        alaScold('friend', (r && r.message) || '门槛没过');
      }
      await friendRefresh();
    };

  const plan = $('#fb-plan');
  if (plan)
    plan.onclick = async () => {
      const r = await api.friendSend({ uid: friendChatUid, text: '📋 转发了一个计划包（导入需二次确认，先进 24h 沙箱）', kind: 'plan' });
      if (!r || !r.ok) {
        toast('没发出去', (r && r.message) || '', true);
        alaScold('friend', (r && r.message) || '门槛没过');
      }
      await friendRefresh();
    };
}

/* ---------------- 阿刺的动手能力：桥接 ----------------
 * 只给阿刺用。阿刺那边模型只出「提议」，用户点了卡片上的按钮才走到这里。
 * 计划：新建 / 修改 / 停用（停用而不是删除，手滑也能救回来）
 * 消息：搭子私聊 / 军团频道 —— 一律走原有发送通道，该拦的照拦、该禁言的照禁言 */
const buddyBridge = {
  friends: () => friendCache,
  addPlan: async (payload, password) => {
    const plan = {
      icon: '🎯', color: 'indigo', when: 'time', time: '09:00', days: [1, 2, 3, 4, 5],
      points: 20, allowProcs: [], needConfirm: false, enabled: true, desc: '',
      ...(payload || {}),
    };
    const r = await api.savePlan(password ? { plan, password } : { plan });
    if (r && r.ok) {
      state = await api.getState();
      render(true);
    }
    return r;
  },
  editPlan: async (id, patch, password) => {
    const base = (state.plans || []).find((p) => p.id === id);
    if (!base) return { ok: false, message: '这条计划已经不在了' };
    const plan = { ...base, ...(patch || {}) };
    const r = await api.savePlan(password ? { plan, password } : { plan });
    if (r && r.ok) {
      state = await api.getState();
      render(true);
    }
    return r;
  },
  dropPlan: async (id) => {
    const r = await api.togglePlan(id, false);
    if (r && r.ok) {
      state = await api.getState();
      render(true);
    }
    return r;
  },
  sendMsg: async (to, text) => {
    if (to === '#channel') {
      const C = window.PQLegionChannel;
      if (!C || typeof C.send !== 'function') return { ok: false, message: '军团频道没开' };
      const r = await C.send(text);
      if (!r || !r.ok) return { ok: false, message: (r && r.message) || '频道没让发' };
      return { ok: true };
    }
    const r = await api.friendSend({ uid: to, text, kind: 'text' });
    if (r && r.ok) await friendRefresh();
    return r || { ok: false, message: '没发出去' };
  },
};

const VIEWS = { today: renderToday, plans: renderPlans, goals: renderGoals, study: renderStudy, legion: renderLegion, friends: renderFriends, guard: renderGuard, stats: renderStats, settings: renderSettings };

/* 整页重绘会重建输入框，正在打的字会丢。重绘前后把输入内容、焦点和光标位置存/取一次。
   只处理文本类输入（复选框、下拉不恢复，避免把用户刚点的操作回滚）。 */
const INPUT_KEEP_TYPES = new Set(['text', 'search', 'number', 'tel', 'password', 'url', 'email']);

function keepInputType(el) {
  if (!el || !el.id) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && INPUT_KEEP_TYPES.has((el.type || '').toLowerCase());
}

function captureInputs(view) {
  const snap = { view, vals: [], activeId: null, start: null, end: null };
  try {
    for (const el of document.querySelectorAll('input[id], textarea[id]')) {
      if (!keepInputType(el) || el.readOnly || el.disabled) continue;
      snap.vals.push([el.id, el.value]);
    }
    const ae = document.activeElement;
    if (keepInputType(ae)) {
      snap.activeId = ae.id;
      try { snap.start = ae.selectionStart; snap.end = ae.selectionEnd; } catch (_) {}
    }
  } catch (_) {}
  return snap;
}

function restoreInputs(snap, view) {
  if (!snap || snap.view !== view) return; // 切换视图时不恢复（元素已换掉）
  try {
    for (const [id, val] of snap.vals) {
      const el = document.getElementById(id);
      if (el && el.value !== val) el.value = val;
    }
    if (snap.activeId) {
      const el = document.getElementById(snap.activeId);
      if (el) {
        el.focus({ preventScroll: true });
        if (typeof snap.start === 'number') {
          try { el.setSelectionRange(snap.start, snap.end); } catch (_) {}
        }
      }
    }
  } catch (_) {}
}

/* 正在打字时跳过整页重绘：innerHTML 全量替换会打断中文输入法组词、
 * 还会把滚动位置甩走。此时记一个「待渲染」，失焦后立刻补一次。 */
let pendingRender = null;
function deferRenderWhileTyping() {
  const ae = document.activeElement;
  if (!ae || (ae.tagName !== 'INPUT' && ae.tagName !== 'TEXTAREA') || ae.readOnly || ae.disabled) return false;
  if (!pendingRender) {
    pendingRender = () => {
      pendingRender = null;
      render(true); // blur 时 Chrome 里 activeElement 仍是被失焦的元素，必须强制渲染
    };
    ae.addEventListener('blur', pendingRender, { once: true });
    // 兜底：元素被换掉导致 blur 不触发时，2 秒后强制补渲染
    setTimeout(() => {
      if (pendingRender) {
        pendingRender = null;
        render(true);
      }
    }, 2000);
  }
  return true;
}

function render(force, resetScroll) {
  if (!force && deferRenderWhileTyping()) return;
  const keep = captureInputs(currentView);
  const docScroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
  const viewEl = $('#view');
  // 切视图时旧滚动位置不能带过来（会把新视图标题顶出容器裁掉），归零
  const viewScroll = resetScroll ? 0 : viewEl ? viewEl.scrollTop : 0;
  applyTheme();
  VIEWS[currentView]();
  updateSideCard();
  restoreInputs(keep, currentView);
  // 重绘会重置滚动位置，恢复回去，避免「往下一拽」
  try {
    if (document.scrollingElement && document.scrollingElement.scrollTop !== docScroll) {
      document.scrollingElement.scrollTop = docScroll;
    }
    if (viewEl && viewEl.scrollTop !== viewScroll) {
      if (resetScroll) viewEl.scrollTo({ top: viewScroll, behavior: 'instant' });
      else viewEl.scrollTop = viewScroll;
    }
  } catch (_) {}
}

function applyTheme() {
  $('#app').dataset.theme = state.settings.theme || 'dark';
}

function updateSideCard() {
  const p = state.profile;
  $('#side-lv').textContent = `Lv.${p.level}`;
  $('#side-streak').textContent = `🔥 ${p.streak} 天`;
  $('#side-bar').style.width = Math.max(0, Math.min(100, (p.levelCur / p.levelNeed) * 100)) + '%';
  $('#side-lv-sub').textContent = `${p.levelCur} / ${p.levelNeed} 积分`;
}

/* ---------------- 微信式消息弹窗（去重 / 不限频合并 / 离线聚合 / 免打扰分粒度） ----------------
 * 引擎在 msg-center.js（纯逻辑可单测），这里只做三件事：
 *   把各路消息喂给它、点弹窗时跳对地方、以及把未读数画成导航小点。
 */
function initMsgCenter() {
  if (!window.PQMsgCenter || msgCenter) return;
  msgCenter = PQMsgCenter.init({
    onJump: (kind, convId) => jumpToChat(kind, convId),
    onMute: () => {
      if (currentView === 'settings') renderSettings();
      paintNavDots();
    },
  });
  window.PQMsg = msgCenter; // 给 buddy.js 等旁路模块投递用（阿刺说话也要弹窗）
  paintNavDots();
  startFriendInboxPoll();
}

/* 点弹窗直接落到那个聊天界面，并顺手清掉这条会话的未读 */
function jumpToChat(kind, convId) {
  const id = String(convId || '');
  if (kind === 'aci') {
    if (window.PQBuddy && typeof PQBuddy.open === 'function') PQBuddy.open();
    return;
  }
  if (kind === 'friend') {
    friendChatUid = id;
    if (msgCenter) msgCenter.engine.markRead('friend:' + id);
    if (typeof api.friendSeen === 'function') {
      try { api.friendSeen(id, Date.now()).catch(() => {}); } catch (_) {}
    }
    switchView('friends');
    setTimeout(() => {
      const box = document.querySelector('.fb-msgs') || document.querySelector('.fb-chat');
      if (box) box.scrollIntoView({ block: 'nearest' });
      paintNavDots();
    }, 60);
    return;
  }
  if (kind === 'room') {
    switchView('study');
    setTimeout(() => {
      const l = $('#chat-list');
      if (l) l.scrollIntoView({ block: 'nearest' });
      paintNavDots();
    }, 60);
    return;
  }
  if (kind === 'channel') {
    switchView('legion');
    setTimeout(() => {
      const l = $('#lgc-log');
      if (l) l.scrollIntoView({ block: 'nearest' });
      paintNavDots();
    }, 60);
  }
}

/* 导航小点：把未读摊到对应入口上，别让人猜哪儿有新消息 */
function paintNavDots() {
  if (!msgCenter) return;
  const u = msgCenter.unreadByKind();
  const map = { study: u.room || 0, legion: u.channel || 0, friends: u.friend || 0 };
  $$('.nav-item').forEach((n) => {
    const v = n.dataset.view;
    const cnt = map[v] || 0;
    let dot = n.querySelector('.nav-dot');
    if (!cnt) {
      if (dot) dot.remove();
      return;
    }
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'nav-dot';
      n.appendChild(dot);
    }
    dot.textContent = cnt > 99 ? '99+' : String(cnt);
  });
}

/* 自习房/娱乐房：正在看这个房间时不弹（跟微信一样，屏幕就在眼前） */
function notifyRoomMsg(msg, mine) {
  if (!msgCenter || mine || msg.sys) return;
  const code = (state && state.room && state.room.code) || 'room';
  const atMe = !!window.PQLegionChat && window.PQLegionChat.mentionsMe(msg.text, (state?.profile?.name) || '我');
  if (currentView === 'study' && !document.hidden && !atMe) {
    msgCenter.engine.markRead('room:' + code);
    return;
  }
  msgCenter.push({
    kind: 'room',
    convId: code,
    name: (state && state.room && (state.room.name || state.room.title)) || '自习房',
    avatar: '🪑',
    from: msg.from,
    text: msg.text,
    id: msg.id,
    mention: atMe,
  });
  paintNavDots();
}

/* 频道：onChange 时按 id 差量取新消息；第一次只建基线，不补历史弹窗 */
function notifyChannelMsgs(C) {
  if (!msgCenter || !C) return;
  let st = null;
  try {
    st = C.state ? C.state() : null;
  } catch (_) {
    st = null;
  }
  const log = (st && st.log) || [];
  const selfUid = (st && st.self && st.self.uid) || '';
  const code = (st && st.code) || 'ch';
  if (!lgcBooted) {
    for (const m of log) if (m && m.id) lgcSeen.add(m.id);
    lgcBooted = true;
    return;
  }
  const meName = (state?.profile?.name) || '我';
  let fresh = 0;
  for (const m of log) {
    if (!m || !m.id || lgcSeen.has(m.id)) continue;
    lgcSeen.add(m.id);
    if (m.uid && m.uid === selfUid) continue;
    const atMe = !!window.PQLegionChat && window.PQLegionChat.mentionsMe(m.text, meName);
    if (currentView === 'legion' && !document.hidden && !atMe) {
      msgCenter.engine.markRead('channel:' + code);
      continue;
    }
    msgCenter.push({
      kind: 'channel',
      convId: code,
      name: '军团频道',
      avatar: '📣',
      from: m.alias,
      text: m.text,
      id: m.id,
      mention: atMe,
    });
    fresh += 1;
  }
  if (lgcSeen.size > 600) lgcSeen = new Set([...lgcSeen].slice(-300));
  if (fresh) paintNavDots();
}

/* 好友私聊：主进程按人聚合好「几条未读」，这里只管弹 */
function startFriendInboxPoll() {
  if (typeof api.friendInbox !== 'function') return;
  const tick = async () => {
    if (!msgCenter) return;
    try {
      const r = await api.friendInbox();
      const th = (r && r.threads) || {};
      const uids = Object.keys(th);
      if (!uids.length) return;
      for (const uid of uids) {
        const t = th[uid];
        if (friendChatUid === uid && currentView === 'friends' && !document.hidden) {
          try { api.friendSeen(uid, Date.now()); } catch (_) {}
          msgCenter.engine.markRead('friend:' + uid);
          continue;
        }
        msgCenter.push({
          kind: 'friend',
          convId: uid,
          name: t.alias,
          avatar: '💬',
          text: t.text,
          id: t.id,
          count: t.count,
        });
      }
      paintNavDots();
    } catch (_) {}
  };
  tick();
  if (friendInboxTimer) clearInterval(friendInboxTimer);
  friendInboxTimer = setInterval(tick, 15000);
}

/* 设置页：全局开关 + 静音名单（弹窗上的 🔕 会往这里加） */
function msgCenterPanelHtml() {
  if (!msgCenter) return '';
  const on = msgCenter.getGlobal();
  const list = msgCenter.list();
  const rows = list.length
    ? list
        .map(
          (it) => `<div class="mc-row">
            <span class="mc-row-t">${esc(PQMsgCenter.KINDS[it.kind] ? PQMsgCenter.KINDS[it.kind].label : it.kind)} · ${esc(it.name || it.convId)}</span>
            <button class="btn small ghost" data-msgpop="unmute" data-k="${esc(it.kind)}" data-i="${esc(it.convId)}">取消静音</button>
          </div>`
        )
        .join('')
    : '<div class="sd">还没有静音的会话。弹窗右上角 🔕 可以把「这个人 / 这个房间 / 这个频道」单独静音——静音只是不弹窗，未读照常记着。</div>';
  return `
    <div class="panel">
      <h3>消息提醒</h3>
      <div class="set-row">
        <div class="set-info">
          <div class="st">弹窗提醒</div>
          <div class="sd">阿刺说话、自习房、军团频道、好友私聊来了消息，右下角弹一个小窗，点一下直接跳过去。关掉之后只是不弹窗，消息一条不少地记着。</div>
        </div>
        <div class="switch ${on ? 'on' : ''}" data-msgpop="global"></div>
      </div>
      <div class="mc-list">
        <div class="st" style="font-size:13px;margin-bottom:6px">单独静音（${list.length}）</div>
        ${rows}
      </div>
      <div class="sd" style="margin-top:8px">同一会话刷屏不会刷出十几个窗，只会合成「N 条新消息」；离线堆着的消息也一样，开机只弹一次汇总。</div>
    </div>`;
}

function bindMsgCenterPanel() {
  $$('[data-msgpop]').forEach((el) => {
    el.onclick = async () => {
      if (!msgCenter) return;
      const act = el.dataset.msgpop;
      if (act === 'global') {
        const on = !el.classList.contains('on');
        msgCenter.setGlobal(on);
        toast(on ? '已打开弹窗提醒' : '已关闭弹窗提醒', on ? '' : '未读仍会记录，导航上照常有小点');
        renderSettings();
        return;
      }
      if (act === 'unmute') {
        msgCenter.unmute(el.dataset.k, el.dataset.i);
        renderSettings();
        paintNavDots();
      }
    };
  });
}

function switchView(name) {
  currentView = name;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  render(true, true); // 切换视图必须立即重绘，且新视图从顶部开始，不受「打字中跳过」影响
}

async function boot() {
  await api.shopInit(); // 首次使用预置默认商城商品
  state = await api.getState();
  render();
  bindRoomEvents();
  api.onToast((t) => toast(t.msg, t.sub || '', true));
  initMsgCenter();
  // 调试：?view=study 直接进入指定视图
  const qv = new URLSearchParams(location.search).get('view');
  if (qv && VIEWS[qv]) switchView(qv);

  /* 好友邀请链接：?inv=<码>&exp=<毫秒>。
   * 海报有效期 24 小时——过期就明说「已过期」，不装作还能用、也不偷偷建立任何关系。 */
  if (window.PQShare && PQShare.checkLink) {
    const lk = PQShare.checkLink();
    if (lk.state === 'expired') {
      toast('这张邀请已经过期', '海报只在发出后 24 小时内有效，让朋友重新生成一张', true);
    } else if (lk.state === 'ok') {
      try {
        localStorage.setItem('pq-inv-recv-v1', JSON.stringify({ inv: lk.inv, at: Date.now(), exp: lk.at }));
      } catch (e) {
        /* 存不下不影响使用 */
      }
      toast('战友喊你一起专注', `邀请码 ${lk.inv.toUpperCase()} · 还剩约 ${lk.leftH} 小时`);
    }
  }

  $$('.nav-item').forEach((n) => (n.onclick = () => switchView(n.dataset.view)));
  mountPlanFileBar(); // 标题栏常驻 [新建][导入][导出]
  const btnMin = $('#btn-min');
  const btnFull = $('#btn-full');
  const btnClose = $('#btn-close');
  if (btnMin) btnMin.onclick = () => api.minimize();
  if (btnFull) btnFull.onclick = () => api.toggleFullscreen();
  if (btnClose) btnClose.onclick = () => api.closeWindow();

  // 独立窗口模式（局域网房间单独成页）：隐藏侧栏，只留视图
  const qs = new URLSearchParams(location.search);
  if (qs.get('standalone') === '1') document.body.classList.add('standalone');

  unsubState = api.onState((s) => {
    state = s;
    applyOverwriteState(s && s.overwrite); // 换皮 / 养成冻结标记
    render();
  });

  /* 军团：start() 在未加入时只挂一个空转的定时器，
     不建连接、不发数据；已加入才会到点补一次 */
  if (window.PQLegion) {
    PQLegion.start({ getState: () => state });
    applyNetPrefs();
    PQLegion.onChange(() => {
      if (currentView !== 'legion') return;
      const ae = document.activeElement;
      if (ae && ae.id && /^lg-(ip|code|alias|alias2)$/.test(ae.id)) return; // 正在填表就先不动
      renderLegion();
    });
  }

  // AI 自训练：把「我的模型」装进两个识别模块（默认官方模型）
  if (window.AITrain) AITrain.applyActive();

  /* 毒舌小助手「阿刺 Pro」：3D 形象 + 查表对话 + 本地语音 + 打开功能 + 原有 AI 管家
   * bridge 给「接消息 / 排计划 / 改计划」用——模型只提议，用户点头才落到这些口子上 */
  if (window.PQBuddy) PQBuddy.start({ getState: () => state, nav: (n) => switchView(n), bridge: buddyBridge });

  /* 启动翻旧账：上次「覆盖」掉的烂尾计划，阿刺会当面翻出来 */
  initOverwrite();

  // 云同步：恢复登录态 → 首次合并 / 增量推送（未登录时完全不影响本机使用）
  if (window.PQCloud && typeof PQCloud.start === 'function') {
    PQCloud.start({
      workbuddyLogin: false, // 桌面版是本地文件页面，账号授权登录的网页跳转回不来
      onConflict: () =>
        confirmDialog(
          '这个账号云端已有数据',
          '点「确定」用云端记录覆盖本机；点「取消」保留本机，并把本机数据上传覆盖云端。'
        ).then((ok) => (ok ? 'remote' : 'local')),
      onApplied: () => {
        api.getState().then((s) => {
          state = s;
          render();
        });
      },
      onChange: () => {
        if (currentView === 'settings' && state) renderSettings();
      },
    });
  }

  // 新手引导：首次打开自动播一次（延迟，避开启动时的其他弹窗）；看完写 guideDone
  if (window.PQOnboarding && window.PQOnboarding.shouldShow(state.settings)) {
    setTimeout(() => { if (!Guide.isActive()) Guide.start(); }, 700);
  }

  // 每分钟刷新一次「今日」视图，让错过/待打卡状态自动流转
  setInterval(() => {
    if (currentView === 'today' && !document.hidden) api.getState().then((s) => ((state = s), renderToday(), updateSideCard()));
  }, 60000);

  // 动态图标（安卓）：有任务进行中 → 启动图标 6 色循环（安卓系统限制，只能步进切换）；
  // 桌面版的顺滑变色由主进程处理，这里只走 Capacitor 插件。
  if (window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform() && Capacitor.getPlugin('IndIcon')) {
    let indAct = false;
    let indFrame = 0;
    setInterval(() => {
      let act = false;
      try {
        const now = new Date();
        const cur = now.getHours() * 60 + now.getMinutes();
        act = (state.todayPlans || []).some((p) => {
          if (p.when === 'boot') return p.status !== 'done';
          const [h, m] = String(p.time || '').split(':').map(Number);
          const s = (h || 0) * 60 + (m || 0);
          return cur >= s && cur <= s + 45 && p.status !== 'done';
        });
      } catch (_) {}
      if (act !== indAct) {
        indAct = act;
        indFrame = 0;
      }
      try {
        if (act) {
          indFrame = (indFrame + 1) % 6;
          Capacitor.getPlugin('IndIcon').set({ i: indFrame });
        } else if (indFrame !== 0) {
          indFrame = 0;
          Capacitor.getPlugin('IndIcon').set({ i: 0 });
        }
      } catch (_) {}
    }, 3000);
  }
}

boot();

/* ================= 新手引导：首次打开用箭头 + 文字走一遍 =================
 * 步骤表与状态判定在 onboarding.js（双端同源，可单测）；这里只做 DOM 演出。
 * 看完 / 跳过写 settings.guideDone=true，以后默认不再弹；设置里可重开。 */
const Guide = (() => {
  let active = false, idx = 0, root = null, hl = null, card = null, arrow = null;
  let raf = 0;

  function ensureRoot() {
    if (root && root.parentNode) return root;
    root = document.createElement('div');
    root.id = 'pq-guide';
    root.className = 'pq-guide';
    root.style.display = 'none';
    root.innerHTML = `
      <div class="pq-guide-hole"></div>
      <div class="pq-guide-card">
        <div class="pq-guide-step"></div>
        <h4 class="pq-guide-title"></h4>
        <p class="pq-guide-text"></p>
        <div class="pq-guide-ops">
          <button type="button" class="pq-guide-skip">跳过</button>
          <span class="pq-guide-spacer"></span>
          <button type="button" class="pq-guide-prev">上一步</button>
          <button type="button" class="pq-guide-next">下一步</button>
        </div>
      </div>
      <div class="pq-guide-arrow"></div>`;
    document.body.appendChild(root);
    hl = root.querySelector('.pq-guide-hole');
    card = root.querySelector('.pq-guide-card');
    arrow = root.querySelector('.pq-guide-arrow');
    root.querySelector('.pq-guide-next').onclick = () => go(idx + 1);
    root.querySelector('.pq-guide-prev').onclick = () => go(idx - 1);
    root.querySelector('.pq-guide-skip').onclick = () => finish(true);
    window.addEventListener('resize', () => { if (active) schedulePlace(); });
    window.addEventListener('keydown', (e) => {
      if (!active) return;
      if (e.key === 'Escape') finish(true);
      else if (e.key === 'ArrowRight' || e.key === 'Enter') go(idx + 1);
      else if (e.key === 'ArrowLeft') go(idx - 1);
    });
    return root;
  }

  function schedulePlace() {
    // 用 setTimeout 而非 rAF：窗口最小化 / 后台标签页里 rAF 会被浏览器节流甚至暂停，
    // 引导气泡会卡在旧位置。16ms 足够等 DOM 重绘，且任何可见状态下都会触发。
    clearTimeout(raf);
    raf = setTimeout(place, 16);
  }

  function place() {
    if (!active || !window.PQOnboarding) return;
    const M = window.PQOnboarding;
    const step = M.stepAt(idx);
    let rect = null;
    if (step.target) {
      const el = document.querySelector(step.target);
      if (el) {
        const b = el.getBoundingClientRect();
        rect = { left: b.left, top: b.top, width: b.width, height: b.height };
      }
    }
    const cardW = Math.min(360, Math.max(260, window.innerWidth - 32));
    const pos = M.place(rect, { w: window.innerWidth, h: window.innerHeight }, { w: cardW, h: 178 }, step.place);
    card.style.left = pos.left + 'px';
    card.style.top = pos.top + 'px';
    card.style.width = cardW + 'px';
    card.querySelector('.pq-guide-step').textContent = `第 ${idx + 1} / ${M.count} 步`;
    card.querySelector('.pq-guide-title').textContent = step.title;
    card.querySelector('.pq-guide-text').textContent = step.text;
    card.querySelector('.pq-guide-prev').style.visibility = idx === 0 ? 'hidden' : 'visible';
    card.querySelector('.pq-guide-next').textContent = idx === M.count - 1 ? '知道了' : '下一步';

    if (pos.highlight) {
      hl.style.display = 'block';
      hl.style.left = pos.highlight.left + 'px';
      hl.style.top = pos.highlight.top + 'px';
      hl.style.width = pos.highlight.width + 'px';
      hl.style.height = pos.highlight.height + 'px';
    } else {
      hl.style.display = 'none';
    }
    // 箭头：气泡边缘的小三角，指向高亮块
    arrow.className = 'pq-guide-arrow';
    if (pos.arrow === 'none') { arrow.style.display = 'none'; }
    else {
      arrow.style.display = 'block';
      const cx = pos.left + cardW / 2, cy = pos.top + 60;
      const cx2 = rect ? rect.left + rect.width / 2 : cx;
      const cy2 = rect ? rect.top + rect.height / 2 : cy;
      const dir = pos.arrow;
      if (dir === 'left') { arrow.style.left = (pos.left - 12) + 'px'; arrow.style.top = Math.max(pos.top + 10, Math.min(cy2 - 8, pos.top + card.offsetHeight - 28)) + 'px'; }
      else if (dir === 'right') { arrow.style.left = (pos.left + cardW) + 'px'; arrow.style.top = Math.max(pos.top + 10, Math.min(cy2 - 8, pos.top + card.offsetHeight - 28)) + 'px'; }
      else if (dir === 'up') { arrow.style.left = Math.max(pos.left + 12, Math.min(cx2 - 8, pos.left + cardW - 28)) + 'px'; arrow.style.top = (pos.top - 12) + 'px'; }
      else { arrow.style.left = Math.max(pos.left + 12, Math.min(cx2 - 8, pos.left + cardW - 28)) + 'px'; arrow.style.top = (pos.top + card.offsetHeight) + 'px'; }
      arrow.dataset.dir = dir;
    }
  }

  function showStep() {
    const M = window.PQOnboarding;
    const step = M.stepAt(idx);
    if (step.view && step.view !== currentView) switchView(step.view);
    // 等切视图重绘完成再量尺寸；无 view 变化时也留一帧给浮标渲染
    schedulePlace();
  }

  function go(n) {
    if (!active || !window.PQOnboarding) return;
    const M = window.PQOnboarding;
    if (n < 0) { finish(false); return; }
    if (n >= M.count) { finish(false); return; }
    idx = n;
    showStep();
  }

  async function finish(skipped) {
    if (!active) return;
    active = false;
    if (root) root.style.display = 'none';
    try { await api.updateSettings({ guideDone: true }); } catch (_) {}
    if (state && state.settings) state.settings.guideDone = true;
    if (skipped) toast('已跳过引导', '想再看一遍：设置 → 新手引导 → 重新播放');
  }

  async function start() {
    if (!window.PQOnboarding) return;
    ensureRoot();
    active = true;
    idx = 0;
    root.style.display = 'block';
    // 让浮标等异步 UI 先就位
    setTimeout(showStep, 120);
  }

  return { start: start, isActive: () => active };
})();

/* 双击 .pqplan（桌面版文件关联）：主进程导入/填充完成后通知这里刷新界面 */
if (window.api && typeof api.onPlanDataChanged === 'function') {
  api.onPlanDataChanged(async () => {
    try {
      state = await api.getState();
      render(true, true);
      toast('计划文件已应用', '已通过 .pqplan 完成导入或填充');
    } catch (_) {}
  });
}
