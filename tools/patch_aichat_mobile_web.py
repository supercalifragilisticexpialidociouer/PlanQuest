# -*- coding: utf-8 -*-
"""把「AI 闲聊雷达」的前端改动同步到安卓 www 与网页版（与桌面 app.js 同源）。"""
import os

STATE_BLOCK = """
/* ---- AI 闲聊雷达（本地文本分类）状态 ---- */
let aiChatOn = true;            // 是否对聊天内容做判定
let aiChatPenalty = true;       // 自己闲聊过多是否扣分
let aiChatStat = null;          // { total, fish, work, skip }
let aiChatMine = [];            // 最近自己判为闲聊的时间戳（5 分钟窗口）"""

CHAT_HEAD_OLD = """        <div class="chat-panel">
          <div class="chat-head">
            <span>💬 房间聊天</span>
            <span class="chat-tip">发广告 / 刷屏 / 重复内容会被自动禁言</span>
          </div>
          <div class="chat-list" id="chat-list"></div>"""

CHAT_HEAD_NEW = """        <div class="chat-panel">
          <div class="chat-head">
            <span>💬 房间聊天</span>
            <span class="chat-tip">发广告 / 刷屏 / 重复内容会被自动禁言</span>
          </div>
          <div class="ai-chat-bar" id="ai-chat-bar">
            <button class="btn small ${aiChatOn ? 'warm' : 'ghost'}" id="aichat-toggle">🤖 闲聊雷达</button>
            <span class="ai-chat-stat" id="aichat-stat">${aiChatStatText()}</span>
            <label class="ai-chat-pen"><input type="checkbox" id="aichat-pen" ${aiChatPenalty ? 'checked' : ''}/> 自己聊太多扣分</label>
          </div>
          <div class="chat-list" id="chat-list"></div>"""

FUNCS = r"""/* ---- AI 闲聊雷达：判定房间聊天是「工作/学习」还是「摸鱼闲聊」 ---- */

const AI_CHAT_PENALTY = 2;   // 抓包一次扣分
const AI_CHAT_WINDOW = 5 * 60 * 1000; // 自己闲聊统计窗口
const AI_CHAT_LIMIT = 3;     // 窗口内闲聊达到几条 → 扣分

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
  const btn = $('#aichat-toggle');
  if (btn) {
    btn.textContent = aiChatOn ? '⏹ 关闭闲聊雷达' : '🤖 闲聊雷达';
    btn.classList.toggle('warm', aiChatOn);
    btn.classList.toggle('ghost', !aiChatOn);
  }
}

/* 判定一条聊天并回写 msg.ai，然后刷新该条气泡（避免整列表重渲染） */
function classifyChat(msg) {
  if (!aiChatOn || !msg || msg.sys) return;
  if (!window.AIChat || typeof AIChat.classify !== 'function') return;
  if (/^🤖/.test(String(msg.text || ''))) return; // AI 自己的广播不判
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
      if (mine && r.label === 'fish' && aiChatPenalty) noteMyFish();
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
  if (m.ai.label === 'fish') return `<span class="chat-badge fish">🐟 闲聊 ${Math.round(m.ai.p * 100)}%</span>`;
  if (m.ai.label === 'work') return `<span class="chat-badge work">📖 正经事 ${Math.round((1 - m.ai.p) * 100)}%</span>`;
  return '';
}

/* 自己连续闲聊 → 扣分（每窗口只扣一次，允许扣成负分） */
function noteMyFish() {
  const now = Date.now();
  aiChatMine = aiChatMine.filter((t) => now - t < AI_CHAT_WINDOW);
  aiChatMine.push(now);
  if (aiChatMine.length < AI_CHAT_LIMIT) {
    const left = AI_CHAT_LIMIT - aiChatMine.length;
    if (left <= 2) toast('🤖 闲聊雷达', `再聊 ${left} 条无关内容就要扣 ${AI_CHAT_PENALTY} 积分`, false);
    return;
  }
  aiChatMine = [];
  toast(`🤖 闲聊被抓包：${AI_CHAT_LIMIT} 条`, `扣除 ${AI_CHAT_PENALTY} 积分 · 回来自习吧！`, true);
  if (typeof api.aiPenalty === 'function') {
    api.aiPenalty(-AI_CHAT_PENALTY)
      .then((res) => {
        if (res && typeof res.points === 'number' && state?.profile) state.profile.points = res.points;
      })
      .catch(() => {});
  }
}

function resetAiChat() {
  aiChatStat = null;
  aiChatMine = [];
  refreshAiChatBar();
}

"""

BIND_OLD = "  $('#ai-toggle') && ($('#ai-toggle').onclick = () => (AIWatch.isRunning() ? AIWatch.stop() : AIWatch.start(() => camStream)));"
BIND_NEW = """  $('#ai-toggle') && ($('#ai-toggle').onclick = () => (AIWatch.isRunning() ? AIWatch.stop() : AIWatch.start(() => camStream)));
  // AI 闲聊雷达：开关 / 抓包扣分
  $('#aichat-toggle') && ($('#aichat-toggle').onclick = () => {
    aiChatOn = !aiChatOn;
    refreshAiChatBar();
    if (aiChatOn) {
      toast('🤖 闲聊雷达已开启', '本地判断聊天是正经事还是闲聊，画面和文字都不上传', false);
      if (window.AIChat) AIChat.preload();
      chatLog.forEach((m) => !m.ai && classifyChat(m));
    } else {
      chatLog.forEach((m) => delete m.ai);
      renderChat();
    }
  });
  $('#aichat-pen') && ($('#aichat-pen').onchange = (e) => {
    aiChatPenalty = !!e.target.checked;
  });"""

RENDER_OLD = """      return `<div class="chat-line"><span class="chat-av">${esc(m.avatar || '🙂')}</span>
        <div class="chat-body"><span class="chat-who">${esc(m.from || '同学')}</span>
        <span class="chat-time">${hh}:${mm}</span>
        <div class="chat-text">${esc(m.text)}</div></div></div>`;"""
RENDER_NEW = """      return `<div class="chat-line" data-cid="${esc(m.id || '')}"><span class="chat-av">${esc(m.avatar || '🙂')}</span>
        <div class="chat-body"><span class="chat-who">${esc(m.from || '同学')}</span>
        <span class="chat-time">${hh}:${mm}</span>
        <div class="chat-text">${esc(m.text)}<span class="chat-badge-slot">${chatBadgeHtml(m)}</span></div></div></div>`;"""

PUSH_OLD = """  chatLog.push(msg);
  if (chatLog.length > 200) chatLog = chatLog.slice(-200);
  renderChat();
}"""
PUSH_NEW = """  chatLog.push(msg);
  if (chatLog.length > 200) chatLog = chatLog.slice(-200);
  renderChat();
  classifyChat(msg); // AI 闲聊雷达：异步判定后回写徽章
}"""

RESET_PAIRS = [
    ("    chatLog = Array.isArray(res.chat) ? res.chat : [];\n    muteSelf = null;\n    // 立刻拉一次最新状态",
     "    chatLog = Array.isArray(res.chat) ? res.chat : [];\n    muteSelf = null;\n    resetAiChat();\n    // 立刻拉一次最新状态"),
    ("        chatLog = Array.isArray(res.chat) ? res.chat : [];\n        muteSelf = null;\n        toast(res.type === 'fun'",
     "        chatLog = Array.isArray(res.chat) ? res.chat : [];\n        muteSelf = null;\n        resetAiChat();\n        toast(res.type === 'fun'"),
    ("    roomJoined = false;\n    roomMembers = [];\n    chatLog = [];\n    muteSelf = null;\n    camStop(true);",
     "    roomJoined = false;\n    roomMembers = [];\n    chatLog = [];\n    muteSelf = null;\n    resetAiChat();\n    camStop(true);"),
    ("      roomJoined = false;\n      roomMembers = [];\n      chatLog = [];\n      muteSelf = null;\n      camStop(true);",
     "      roomJoined = false;\n      roomMembers = [];\n      chatLog = [];\n      muteSelf = null;\n      resetAiChat();\n      camStop(true);"),
]

STYLE_ANCHOR = ".ai-status { font-size: 12px; color: var(--text-3); white-space: nowrap; }"
STYLE_ADD = """.ai-chat-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px; border-bottom: 1px dashed var(--border);
  background: rgba(23, 205, 168, 0.04);
}
.ai-chat-stat { font-size: 11px; color: var(--text-3); }
.ai-chat-pen { font-size: 11px; color: var(--text-3); display: flex; align-items: center; gap: 4px; margin-left: auto; }
.chat-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; margin-left: 6px; white-space: nowrap; vertical-align: middle; }
.chat-badge.fish { background: rgba(229, 72, 77, 0.14); color: #d43b40; }
.chat-badge.work { background: rgba(46, 164, 95, 0.14); color: #2a8f53; }

"""


def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    if 'aichat-toggle' in s:
        print('skip (已打过)', path)
        return
    miss = []
    for old, new in pairs:
        if old in s:
            s = s.replace(old, new, 1)
        else:
            miss.append(old.strip().split('\n')[0][:50])
    tmp = path + '.tmp'
    open(tmp, 'w', encoding='utf-8', newline='').write(s)
    os.replace(tmp, path)
    print('patched', path, ('缺锚点: %s' % miss) if miss else 'ok')


for app in ('android-app/www/app.js', 'web/app.js'):
    patch(app, [
        ("let funTickTimer = null; // 娱乐房倒计时刷新\n", "let funTickTimer = null; // 娱乐房倒计时刷新\n" + STATE_BLOCK + "\n"),
        (CHAT_HEAD_OLD, CHAT_HEAD_NEW),
        ("/* ---- 聊天渲染 ---- */", FUNCS + "/* ---- 聊天渲染 ---- */"),
        (RENDER_OLD, RENDER_NEW),
        (PUSH_OLD, PUSH_NEW),
        (BIND_OLD, BIND_NEW),
    ])
    # 房间加入/退出时重置统计
    s = open(app, encoding='utf-8').read()
    n = 0
    for old, new in RESET_PAIRS:
        if old in s:
            s = s.replace(old, new, 1)
            n += 1
    tmp = app + '.tmp'
    open(tmp, 'w', encoding='utf-8', newline='').write(s)
    os.replace(tmp, app)
    print('  reset 插入', n, '/', len(RESET_PAIRS))

for css in ('android-app/www/styles.css', 'web/styles.css'):
    s = open(css, encoding='utf-8').read()
    if '.ai-chat-bar' in s:
        print('skip style', css)
        continue
    assert STYLE_ANCHOR in s, css
    s = s.replace(STYLE_ANCHOR, STYLE_ADD + STYLE_ANCHOR, 1)
    tmp = css + '.tmp'
    open(tmp, 'w', encoding='utf-8', newline='').write(s)
    os.replace(tmp, css)
    print('styles patched', css)
