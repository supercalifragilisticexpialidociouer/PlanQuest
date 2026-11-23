import io, os, sys

F = 'src/renderer/app.js'
s = io.open(F, encoding='utf-8').read()
orig = s
n = 0

def rep(old, new, cnt=1):
    global s, n
    if old not in s:
        print('!! MISS:', old.split('\n')[0][:70])
        sys.exit(1)
    s = s.replace(old, new, cnt)
    n += 1

# 1) 闲聊雷达强制常开：状态注释
rep("let aiChatOn = true;            // 是否对聊天内容做判定",
    "let aiChatOn = true;            // 强制常开（需求：闲聊雷达不给关，只保留判定与统计）")

# 2) 房间里 AI 盯学按钮改为常开状态 + 提示文案
rep("""          <button class="btn small ${AIWatch.isRunning() ? 'warm' : 'ghost'}" id="ai-toggle">🤖 AI 盯学</button>""",
    """          <button class="btn small warm" id="ai-toggle" title="强制开启：关闭摄像头才会停止">🤖 AI 盯学 · 常开</button>""")
rep("""          <span class="chat-tip">自愿开启 · 退出房间自动关闭</span>""",
    """          <span class="chat-tip">强制开启 · 开摄像头即盯学，退出房间自动结束</span>""")

# 3) 抓包后的纠错条
rep("""        <div class="reaction-row">""",
    """        <div class="ai-fb" id="ai-fb" hidden>
          <span class="ai-fb-t">🤖 刚才那帧真的是摸鱼吗？</span>
          <button class="btn small ghost" id="ai-fb-yes">确实是摸鱼</button>
          <button class="btn small ghost" id="ai-fb-no">我在学习（误判）</button>
          <span class="chat-tip">你的回答会存成训练样本</span>
        </div>
        <div class="reaction-row">""")

# 4) 闲聊雷达：去掉开关按钮
rep("""            <button class="btn small ${aiChatOn ? 'warm' : 'ghost'}" id="aichat-toggle">🤖 闲聊雷达</button>
            <span class="ai-chat-stat" id="aichat-stat">${aiChatStatText()}</span>""",
    """            <span class="ai-force">🟢 闲聊雷达 · 强制开启</span>
            <span class="ai-chat-stat" id="aichat-stat">${aiChatStatText()}</span>""")

# 5) 去掉开关绑定
rep("""  // AI 闲聊雷达：开关 / 抓包扣分
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
  });""",
    """  // AI 闲聊雷达：强制常开，只保留「自己聊太多扣分」这一项
  if (window.AIChat) AIChat.preload();
  chatLog.forEach((m) => !m.ai && classifyChat(m));
  $('#aichat-pen') && ($('#aichat-pen').onchange = (e) => {
    aiChatPenalty = !!e.target.checked;
  });
  // AI 徽章点一下可以纠正 → 变成训练样本
  $('#chat-list') && ($('#chat-list').onclick = onChatBadgeClick);
  bindAiFeedback();""")

# 6) refreshAiChatBar 不再管按钮
rep("""function refreshAiChatBar() {
  const stat = $('#aichat-stat');
  if (stat) stat.textContent = aiChatStatText();
  const btn = $('#aichat-toggle');
  if (btn) {
    btn.textContent = aiChatOn ? '⏹ 关闭闲聊雷达' : '🤖 闲聊雷达';
    btn.classList.toggle('warm', aiChatOn);
    btn.classList.toggle('ghost', !aiChatOn);
  }
}""",
    """function refreshAiChatBar() {
  const stat = $('#aichat-stat');
  if (stat) stat.textContent = aiChatStatText();
}""")

# 7) AI 盯学按钮：不给关
rep("""  $('#ai-toggle') && ($('#ai-toggle').onclick = () => (AIWatch.isRunning() ? AIWatch.stop() : AIWatch.start(() => camStream)));""",
    """  $('#ai-toggle') &&
    ($('#ai-toggle').onclick = () => {
      if (!AIWatch.isRunning()) return AIWatch.start(() => camStream);
      toast('🤖 AI 盯学是强制开启的', '想停下来就点「⏹ 关闭摄像头共享」，退出房间也会自动结束', false);
    });""")

# 8) 开摄像头 → 自动开始盯学（强制）
rep("""    syncRoomState();
    renderCamStrip();
    updateCamBtn();
    toast('📷 摄像头已共享', '房间成员现在能看到你的画面，再点一次关闭');""",
    """    syncRoomState();
    renderCamStrip();
    updateCamBtn();
    // 强制开启：摄像头一开就开始盯学
    if (window.AIWatch && !AIWatch.isRunning()) AIWatch.start(() => camStream);
    toast('📷 摄像头已共享', '房间成员能看到你的画面；AI 盯学已自动开启');""")

# 9) 徽章带上可点击标记
rep("""function chatBadgeHtml(m) {
  if (!aiChatOn || !m || !m.ai) return '';
  if (m.ai.label === 'fish') return `<span class="chat-badge fish">🐟 闲聊 ${Math.round(m.ai.p * 100)}%</span>`;
  if (m.ai.label === 'work') return `<span class="chat-badge work">📖 正经事 ${Math.round((1 - m.ai.p) * 100)}%</span>`;
  return '';
}""",
    """function chatBadgeHtml(m) {
  if (!aiChatOn || !m || !m.ai) return '';
  const fix = ` data-fix="${esc(m.id || '')}" title="点一下纠正 → 存成训练样本"`;
  if (m.ai.label === 'fish') return `<span class="chat-badge fish"${fix}>🐟 闲聊 ${Math.round(m.ai.p * 100)}%</span>`;
  if (m.ai.label === 'work') return `<span class="chat-badge work"${fix}>📖 正经事 ${Math.round((1 - m.ai.p) * 100)}%</span>`;
  return '';
}""")

# 10) 设置页插入「AI 自训练」面板
rep("""    <div class="panel">
      <h3>外观</h3>""",
    """    ${aiTrainPanelHTML()}

    <div class="panel">
      <h3>外观</h3>""")

# 11) 设置页绑定
rep("""  bindShopPanel();
  bindCloudPanel();
  bindLkPanel();""",
    """  bindShopPanel();
  bindCloudPanel();
  bindLkPanel();
  bindAiTrainPanel();""")

# 12) 启动时装载自训练模型
rep("""  // 云同步：恢复登录态 → 首次合并 / 增量推送（未登录时完全不影响本机使用）""",
    """  // AI 自训练：把「我的模型」装进两个识别模块（默认官方模型）
  if (window.AITrain) AITrain.applyActive();

  // 云同步：恢复登录态 → 首次合并 / 增量推送（未登录时完全不影响本机使用）""")

io.open(F + '.tmp', 'w', encoding='utf-8', newline='').write(s)
os.replace(F + '.tmp', F)
print('app.js patched hunks:', n, 'delta bytes:', len(s) - len(orig))
