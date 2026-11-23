"""把「强制开启 + 自训练」补丁同步到安卓版 / 网页版的 app.js（与桌面版同一套逻辑）"""
import io, os, re, sys


def patch(F):
    s = io.open(F, encoding='utf-8').read()
    orig = s
    n = 0

    def rep(old, new, cnt=1):
        nonlocal s, n
        if old not in s:
            raise SystemExit('!! MISS in %s: %s' % (F, old.split('\n')[0][:70]))
        s = s.replace(old, new, cnt)
        n += 1

    rep(
        "let aiChatOn = true;            // 是否对聊天内容做判定",
        "let aiChatOn = true;            // 强制常开（需求：闲聊雷达不给关，只保留判定与统计）",
    )
    rep(
        """          <button class="btn small ${AIWatch.isRunning() ? 'warm' : 'ghost'}" id="ai-toggle">🤖 AI 盯学</button>""",
        """          <button class="btn small warm" id="ai-toggle" title="强制开启：关闭摄像头才会停止">🤖 AI 盯学 · 常开</button>""",
    )
    rep(
        """          <span class="chat-tip">自愿开启 · 退出房间自动关闭</span>""",
        """          <span class="chat-tip">强制开启 · 开摄像头即盯学，退出房间自动结束</span>""",
    )
    rep(
        """        <div class="reaction-row">""",
        """        <div class="ai-fb" id="ai-fb" hidden>
          <span class="ai-fb-t">🤖 刚才那帧真的是摸鱼吗？</span>
          <button class="btn small ghost" id="ai-fb-yes">确实是摸鱼</button>
          <button class="btn small ghost" id="ai-fb-no">我在学习（误判）</button>
          <span class="chat-tip">你的回答会存成训练样本</span>
        </div>
        <div class="reaction-row">""",
    )
    rep(
        """            <button class="btn small ${aiChatOn ? 'warm' : 'ghost'}" id="aichat-toggle">🤖 闲聊雷达</button>
            <span class="ai-chat-stat" id="aichat-stat">${aiChatStatText()}</span>""",
        """            <span class="ai-force">🟢 闲聊雷达 · 强制开启</span>
            <span class="ai-chat-stat" id="aichat-stat">${aiChatStatText()}</span>""",
    )
    rep(
        """  // AI 闲聊雷达：开关 / 抓包扣分
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
  });""",
        """  // AI 闲聊雷达：强制常开，只保留「自己聊太多扣分」这一项
  if (window.AIChat) AIChat.preload();
  chatLog.forEach((m) => !m.ai && classifyChat(m));
  // AI 徽章点一下可以纠正 → 变成训练样本
  $('#chat-list') && ($('#chat-list').onclick = onChatBadgeClick);
  bindAiFeedback();""",
    )
    rep(
        """function refreshAiChatBar() {
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
}""",
    )
    rep(
        """  $('#ai-toggle') && ($('#ai-toggle').onclick = () => (AIWatch.isRunning() ? AIWatch.stop() : AIWatch.start(() => camStream)));""",
        """  $('#ai-toggle') &&
    ($('#ai-toggle').onclick = () => {
      if (!AIWatch.isRunning()) return AIWatch.start(() => camStream);
      toast('🤖 AI 盯学是强制开启的', '想停下来就点「⏹ 关闭摄像头共享」，退出房间也会自动结束', false);
    });""",
    )
    rep(
        """    syncRoomState();
    renderCamStrip();
    updateCamBtn();
    toast('📷 摄像头已共享', '房间成员现在能看到你的画面，再点一次关闭');""",
        """    syncRoomState();
    renderCamStrip();
    updateCamBtn();
    // 强制开启：摄像头一开就开始盯学
    if (window.AIWatch && !AIWatch.isRunning()) AIWatch.start(() => camStream);
    toast('📷 摄像头已共享', '房间成员能看到你的画面；AI 盯学已自动开启');""",
    )
    rep(
        """function chatBadgeHtml(m) {
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
}""",
    )
    rep(
        """    <div class="panel">
      <h3>外观</h3>""",
        """    ${aiTrainPanelHTML()}

    <div class="panel">
      <h3>外观</h3>""",
    )

    # 设置页绑定：插到第一个 bindCloudPanel(); 后面
    m = re.search(r'\n  bindCloudPanel\(\);\n', s)
    if not m:
        raise SystemExit('!! MISS bindCloudPanel in ' + F)
    s = s[: m.end()] + '  bindAiTrainPanel();\n' + s[m.end() :]
    n += 1

    # 启动时装载自训练模型
    m = re.search(r'\n  // 云同步：恢复登录态', s)
    if not m:
        raise SystemExit('!! MISS boot anchor in ' + F)
    s = s[: m.start()] + '\n  // AI 自训练：把「我的模型」装进两个识别模块（默认官方模型）\n  if (window.AITrain) AITrain.applyActive();\n' + s[m.start() + 1 :]
    n += 1

    io.open(F + '.tmp', 'w', encoding='utf-8', newline='').write(s)
    os.replace(F + '.tmp', F)
    print('patched %s hunks=%d delta=%d' % (F, n, len(s) - len(orig)))


for f in sys.argv[1:]:
    patch(f)
