'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  /* R2 直链版本更新 / 可选大模型下载（桌面版专属） */
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateComponents: (ids) => ipcRenderer.invoke('update:components', ids),
  /* 阿刺养成 + 战友 PK */
  aciState: () => ipcRenderer.invoke('aci:state'),
  aciAction: (action, payload) => ipcRenderer.invoke('aci:action', action, payload),
  aciRoomSay: (text) => ipcRenderer.invoke('aci:roomSay', text),
  onUpdateStage: (cb) => {
    const h = (_e, t) => cb && cb(t);
    ipcRenderer.on('update:stage', h);
    return () => ipcRenderer.removeListener('update:stage', h);
  },
  /* 轻量哈希检查：启动/定时查一次远端哈希，不一致弹「检测到新版本」 */
  updateHashCheck: () => ipcRenderer.invoke('update:hashCheck'),
  updateHashAck: (payload) => ipcRenderer.invoke('update:hashAck', payload),
  onUpdateHashFound: (cb) => {
    const h = (_e, p) => cb && cb(p);
    ipcRenderer.on('update:hashFound', h);
    return () => ipcRenderer.removeListener('update:hashFound', h);
  },
  livekitStatus: () => ipcRenderer.invoke('livekit:status'),
  livekitConfig: (cfg) => ipcRenderer.invoke('livekit:config', cfg),

  // 云同步：读本机原始数据 / 用云端数据覆盖本机 / 本机数据变动通知
  cloudGet: () => ipcRenderer.invoke('cloud:get'),
  cloudApply: (state) => ipcRenderer.invoke('cloud:apply', state),
  onLocalChange: (cb) => {
    const handler = () => cb && cb();
    ipcRenderer.on('cloud:localChange', handler);
    return () => ipcRenderer.removeListener('cloud:localChange', handler);
  },

  savePlan: (plan) => ipcRenderer.invoke('plan:save', plan),
  deletePlan: (id) => ipcRenderer.invoke('plan:delete', id),
  togglePlan: (id, enabled) =>
    ipcRenderer.invoke('plan:toggle', id && typeof id === 'object' ? { id: id.id, enabled: id.enabled } : { id, enabled }),
  checkin: (id, password) => ipcRenderer.invoke('checkin:do', { planId: id, password }),
  // 护眼模式：开关 / 跳过都要守护密码；息屏与引导界面接收主进程推送
  eyeCareToggle: (payload) => ipcRenderer.invoke('eyecare:toggle', payload),
  eyeCareSkip: (payload) => ipcRenderer.invoke('eyecare:skip', payload),
  eyeCareDone: () => ipcRenderer.invoke('eyecare:done'),
  eyeCareInfo: () => ipcRenderer.invoke('eyecare:info'),
  eyeCarePlan: (payload) => ipcRenderer.invoke('eyecare:plan', payload),
  onEyeCare: (cb) => {
    const h = (_e, data) => cb && cb(data);
    ipcRenderer.on('eyecare:show', h);
    return () => ipcRenderer.removeListener('eyecare:show', h);
  },
  undoCheckin: (id) => ipcRenderer.invoke('checkin:undo', id),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
  exportData: () => ipcRenderer.invoke('app:export'),

  /* 计划文件（.pqplan）：导入 / 导出 / 校验应用 */
  planfileBuild: () => ipcRenderer.invoke('planfile:build'),
  planfileExport: (scope, legion) => ipcRenderer.invoke('planfile:export', { scope, legion }),
  planfileNew: () => ipcRenderer.invoke('planfile:new'),
  planfilePick: () => ipcRenderer.invoke('planfile:pick'),
  planfileApply: (args) => ipcRenderer.invoke('planfile:apply', args),
  planfileBlankTemplate: (filePath) => ipcRenderer.invoke('planfile:blank-template', filePath),
  planfileForward: (scope) => ipcRenderer.invoke('planfile:forward', scope),
  planfileImportText: (payload) => ipcRenderer.invoke('planfile:importText', payload),
  onPlanDataChanged: (cb) => {
    const handler = () => cb && cb();
    ipcRenderer.on('plan-data-changed', handler);
    return () => ipcRenderer.removeListener('plan-data-changed', handler);
  },
  /* .pqplan 覆盖：只编辑不应用 / 启动翻旧账 / 加密备份 / 阿刺播报 */
  planfileSaveEnvelope: (args) => ipcRenderer.invoke('planfile:saveEnvelope', args),
  overwriteBoot: () => ipcRenderer.invoke('overwrite:boot'),
  overwriteVault: (at) => ipcRenderer.invoke('overwrite:vault', at),
  onOverwriteSay: (cb) => {
    const handler = (_e, payload) => cb && cb(payload);
    ipcRenderer.on('overwrite:say', handler);
    return () => ipcRenderer.removeListener('overwrite:say', handler);
  },

  reminderAction: (payload) => ipcRenderer.invoke('reminder:action', payload),
  testReminder: (planId) => ipcRenderer.invoke('reminder:test', planId),

  // 自习房
  roomCreate: (info) => ipcRenderer.invoke('room:create', info),
  roomProbe: (payload) => ipcRenderer.invoke('room:probe', payload),
  roomJoin: (info) => ipcRenderer.invoke('room:join', info),
  roomLeave: () => ipcRenderer.invoke('room:leave'),
  roomReaction: (emoji) => ipcRenderer.invoke('room:reaction', emoji),
  roomState: (state) => ipcRenderer.invoke('room:state', state),
  roomRtc: (payload) => ipcRenderer.invoke('room:rtc', payload),
  // 聊天 / 禁言 / 拉人
  roomChat: (text, link) => ipcRenderer.invoke('room:chat', text, link),
  roomCamFrame: (data) => ipcRenderer.invoke('room:camFrame', data),
  // 屏幕共享：列源 / 选定源 / 发帧
  screenSources: () => ipcRenderer.invoke('screen:sources'),
  screenPick: (id) => ipcRenderer.invoke('screen:pick', id),
  roomShareFrame: (data) => ipcRenderer.invoke('room:shareFrame', data),
  // 异地联机：本地连接码编解码（不联网）
  netCreate: () => ipcRenderer.invoke('net:create'),
  netOpenWindow: (type) => ipcRenderer.invoke('net:openWindow', type),
  netCreateRoom: (info) => ipcRenderer.invoke('net:createRoom', info),
  netPeerId: (prefix) => ipcRenderer.invoke('net:peerId', prefix),
  netPack: (obj) => ipcRenderer.invoke('net:pack', obj),
  netUnpack: (text) => ipcRenderer.invoke('net:unpack', text),
  roomMute: (payload) => ipcRenderer.invoke('room:mute', payload),
  roomUnmute: (id) => ipcRenderer.invoke('room:unmute', id),
  roomPeers: () => ipcRenderer.invoke('room:peers'),
  roomInvite: (payload) => ipcRenderer.invoke('room:invite', payload),
  roomCompanion: (joined) => ipcRenderer.invoke('room:companion', joined),
  roomFunConfig: () => ipcRenderer.invoke('room:funConfig'),

  /* 军团：局域网批量同步（和自习房同一套 TCP 行协议） */
  legionCreate: (info) => ipcRenderer.invoke('legion:create', info),
  legionJoin: (info) => ipcRenderer.invoke('legion:join', info),
  legionLeave: () => ipcRenderer.invoke('legion:leave'),
  legionPush: (bundle) => ipcRenderer.invoke('legion:push', bundle),
  legionStatus: () => ipcRenderer.invoke('legion:status'),

  /* 军团治理 */
  govState: () => ipcRenderer.invoke('gov:state'),
  govCreate: (p) => ipcRenderer.invoke('gov:create', p),
  govCast: (p) => ipcRenderer.invoke('gov:cast', p),
  govReport: (p) => ipcRenderer.invoke('gov:report', p),
  govAssign: (p) => ipcRenderer.invoke('gov:assign', p),
  govRevoke: (p) => ipcRenderer.invoke('gov:revoke', p),
  govAnnounceLeave: (p) => ipcRenderer.invoke('gov:announceLeave', p),
  govAnnounceElection: () => ipcRenderer.invoke('gov:announceElection'),
  govCampaign: () => ipcRenderer.invoke('gov:campaign'),
  govBallot: (p) => ipcRenderer.invoke('gov:ballot', p),
  /* 好友区（F0/F1/F2） */
  friendState: () => ipcRenderer.invoke('friend:state'),
  friendGateNew: (p) => ipcRenderer.invoke('friend:gateNew', p),
  friendGateAnswer: (p) => ipcRenderer.invoke('friend:gateAnswer', p),
  friendBond: (p) => ipcRenderer.invoke('friend:bond', p),
  friendPeerRate: (p) => ipcRenderer.invoke('friend:peerRate', p),
  friendSend: (p) => ipcRenderer.invoke('friend:send', p),
  friendMsgs: (uid) => ipcRenderer.invoke('friend:msgs', uid),
  friendInbox: () => ipcRenderer.invoke('friend:inbox'),
  friendSeen: (uid, at) => ipcRenderer.invoke('friend:seen', uid, at),
  friendSettle: () => ipcRenderer.invoke('friend:settle'),
  friendRank: () => ipcRenderer.invoke('friend:rank'),
  friendPactSet: (p) => ipcRenderer.invoke('friend:pactSet', p),
  friendPactSettle: (p) => ipcRenderer.invoke('friend:pactSettle', p),

  // 阿刺引擎：本地 Qwen3-4B + 查表
  alaProbe: (cfg) => ipcRenderer.invoke('ala:probe', cfg),
  alaAsk: (p) => ipcRenderer.invoke('ala:ask', p),
  alaWeb: (p) => ipcRenderer.invoke('ala:web', p),
  // 朗读（MeloTTS-ZH 本地服务，起不来由渲染层回落系统语音）
  alaTtsProbe: (p) => ipcRenderer.invoke('ala:ttsProbe', p),
  alaTts: (p) => ipcRenderer.invoke('ala:tts', p),
  // 复制（走主进程剪贴板，file:// 下比 navigator.clipboard 靠谱）
  clipboardWrite: (t) => ipcRenderer.invoke('app:copy', t),
  /* 集体任务 / Lv1-Lv3 管理权 */
  govCollectiveSet: (p) => ipcRenderer.invoke('gov:collectiveSet', p),
  govCollectiveProgress: (p) => ipcRenderer.invoke('gov:collectiveProgress', p),
  govFold: (p) => ipcRenderer.invoke('gov:fold', p),
  govWatch: (uid) => ipcRenderer.invoke('gov:watch', uid),
  govModerateStart: (p) => ipcRenderer.invoke('gov:moderateStart', p),
  govEvictStart: (p) => ipcRenderer.invoke('gov:evictStart', p),
  govAppeal: (p) => ipcRenderer.invoke('gov:appeal', p),
  /* .pqplan 安全四件套 */
  planPreview: (p) => ipcRenderer.invoke('planfile:preview', p),
  planSandbox: () => ipcRenderer.invoke('planfile:sandbox'),
  planSandboxPromote: () => ipcRenderer.invoke('planfile:sandboxPromote'),
  planSandboxDrop: () => ipcRenderer.invoke('planfile:sandboxDrop'),
  planBanToggle: (p) => ipcRenderer.invoke('planfile:banToggle', p),
  govElectionApply: (p) => ipcRenderer.invoke('gov:electionApply', p),
  govDefs: () => ipcRenderer.invoke('gov:defs'),
  legionHubStart: (info) => ipcRenderer.invoke('legion:hubStart', info),
  legionAbsorb: (info) => ipcRenderer.invoke('legion:absorb', info),
  legionMeshStart: (info) => ipcRenderer.invoke('legion:meshStart', info),
  legionMeshAbsorb: (info) => ipcRenderer.invoke('legion:meshAbsorb', info),
  legionAgg: () => ipcRenderer.invoke('legion:agg'),
  legionLamp: () => ipcRenderer.invoke('legion:lamp'),
  legionClaimLamp: () => ipcRenderer.invoke('legion:claimLamp'),
  legionPos: (uid) => ipcRenderer.invoke('legion:pos', uid),
  legionHostLamp: () => ipcRenderer.invoke('legion:hostLamp'),
  legionBadge: (weekKey) => ipcRenderer.invoke('legion:badge', weekKey),
  legionMute: (b) => ipcRenderer.invoke('legion:mute', !!b),
  legionPkStatus: () => ipcRenderer.invoke('legion:pkStatus'),
  legionPkJoin: () => ipcRenderer.invoke('legion:pkJoin'),
  // 军团频道：规则 / 发言 / 团长处置
  legionChatState: () => ipcRenderer.invoke('legion:chatState'),
  legionChatSend: (text, invite) => ipcRenderer.invoke('legion:chatSend', text, invite),
  legionTierInfo: () => ipcRenderer.invoke('legion:tierInfo'),
  legionChatRules: (patch) => ipcRenderer.invoke('legion:chatRules', patch),
  legionChatMute: (info) => ipcRenderer.invoke('legion:chatMute', info),
  legionChatDefs: () => ipcRenderer.invoke('legion:chatDefs'),
  roomInviteInfo: () => ipcRenderer.invoke('room:inviteInfo'),
  onLegion: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('legion:event', handler);
    return () => ipcRenderer.removeListener('legion:event', handler);
  },
  profileUpdate: (patch) => ipcRenderer.invoke('profile:update', patch),
  // AI 盯学：摸鱼检测扣分（负数）
  aiPenalty: (points) => ipcRenderer.invoke('ai:penalty', { points }),
  // AI 自训练数据：落盘在主进程，主窗口 / 异地联机窗口共用
  aiStore: {
    load: () => ipcRenderer.sendSync('ai:store:load'),
    save: (json) => ipcRenderer.send('ai:store:save', json),
  },
  // AI 闲聊雷达：file:// 页面不能 fetch，由主进程读安装目录里的模型资源（Uint8Array）
  readVendorFile: (rel) => ipcRenderer.invoke('vendor:read', rel),
  onRoom: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('room:event', handler);
    return () => ipcRenderer.removeListener('room:event', handler);
  },

  // 番茄钟 / 三件事
  focusComplete: (payload) => ipcRenderer.invoke('focus:complete', payload),
  mitAdd: (text) => ipcRenderer.invoke('mit:add', text),
  mitToggle: (id) => ipcRenderer.invoke('mit:toggle', id),
  mitDelete: (id) => ipcRenderer.invoke('mit:delete', id),

  // 守护（强制模式）
  guardInfo: () => ipcRenderer.invoke('guard:info'),
  guardSetup: (info) => ipcRenderer.invoke('guard:setup', info),
  guardSetLists: (payload) => ipcRenderer.invoke('guard:setLists', payload),
  guardToggle: (payload) => ipcRenderer.invoke('guard:toggle', payload),
  guardProcesses: () => ipcRenderer.invoke('guard:processes'),
  guardAdminRestart: () => ipcRenderer.invoke('guard:adminRestart'),
  guardRedeemGray: (payload) => ipcRenderer.invoke('guard:redeemGray', payload),

  // 积分商城
  shopInit: () => ipcRenderer.invoke('shop:init'),
  shopAddItem: (item) => ipcRenderer.invoke('shop:addItem', item),
  shopDeleteItem: (payload) => ipcRenderer.invoke('shop:deleteItem', payload),
  shopRedeem: (id) => ipcRenderer.invoke('shop:redeem', id),
  shopRescueStart: () => ipcRenderer.invoke('shop:rescueStart'),
  microComplete: (step) => ipcRenderer.invoke('micro:complete', step),
  creditBorrow: (amount) => ipcRenderer.invoke('credit:borrow', amount),
  creditState: () => ipcRenderer.invoke('credit:state'),
  creditPenalize: (payload) => ipcRenderer.invoke('credit:penalize', payload),
  creditEvent: (payload) => ipcRenderer.invoke('credit:event', payload),

  /* 军团纪律：逃兵 / 刷分 / 契约 / 外挂 / 解冻 */
  discState: () => ipcRenderer.invoke('disc:state'),
  discSession: (payload) => ipcRenderer.invoke('disc:session', payload),
  discContractNew: (payload) => ipcRenderer.invoke('disc:contractNew', payload),
  discContractSettle: (payload) => ipcRenderer.invoke('disc:contractSettle', payload),
  discScan: () => ipcRenderer.invoke('disc:scan'),
  discReview: (payload) => ipcRenderer.invoke('disc:review', payload),
  discThaw: () => ipcRenderer.invoke('disc:thaw'),

  /* GitHub token 自动识别（只回来源与掩码，不回完整 token） */
  pkToken: () => ipcRenderer.invoke('pk:token'),
  pkTokenRefresh: () => ipcRenderer.invoke('pk:tokenRefresh'),

  /* GitHub 官方 OAuth（Device Flow） */
  pkOauthStart: () => ipcRenderer.invoke('pk:oauthStart'),
  pkOauthPoll: () => ipcRenderer.invoke('pk:oauthPoll'),
  pkOauthCancel: () => ipcRenderer.invoke('pk:oauthCancel'),
  pkOauthLogout: () => ipcRenderer.invoke('pk:oauthLogout'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  witnessSet: (payload) => ipcRenderer.invoke('witness:set', payload),

  // 目标 / 契约
  goalAdd: (g) => ipcRenderer.invoke('goal:add', g),
  goalDelete: (id) => ipcRenderer.invoke('goal:delete', id),
  goalToggleMilestone: (p) => ipcRenderer.invoke('goal:toggleMilestone', p),
  goalAddMilestone: (p) => ipcRenderer.invoke('goal:addMilestone', p),
  goalDeleteMilestone: (p) => ipcRenderer.invoke('goal:deleteMilestone', p),
  contractAdd: (c) => ipcRenderer.invoke('contract:add', c),
  contractCheckin: (id) => ipcRenderer.invoke('contract:checkin', id),
  contractPay: (p) => ipcRenderer.invoke('contract:pay', p),
  contractDelete: (id) => ipcRenderer.invoke('contract:delete', id),
  contractProjectAdd: (p) => ipcRenderer.invoke('contractProject:add', p),
  contractProjectDelete: (id) => ipcRenderer.invoke('contractProject:delete', id),
  contractProjectPay: (p) => ipcRenderer.invoke('contractProject:pay', p),

  // 小结 / 复盘 / 补卡
  diarySave: (p) => ipcRenderer.invoke('diary:save', p),
  reviewSetItems: (p) => ipcRenderer.invoke('review:setItems', p),
  makeupAdd: (p) => ipcRenderer.invoke('makeup:add', p),

  // 专注模式 / 导出
  focusToggle: (on) => ipcRenderer.invoke('focus:toggle', { on }),
  exportCsv: () => ipcRenderer.invoke('export:csv'),
  exportCalendar: () => ipcRenderer.invoke('export:calendar'),

  // 未授权软件提醒弹窗
  unlistedClose: () => ipcRenderer.send('unlisted:close'),
  unlistedKill: (names) => ipcRenderer.invoke('unlisted:kill', names),
  onUnlisted: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('unlisted:data', handler);
    return () => ipcRenderer.removeListener('unlisted:data', handler);
  },
  onToast: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('app:toast', handler);
    return () => ipcRenderer.removeListener('app:toast', handler);
  },

  minimize: () => ipcRenderer.send('win:minimize'),
  toggleFullscreen: () => ipcRenderer.send('win:toggleFullscreen'),
  setFullscreen: (on) => ipcRenderer.invoke('win:setFullscreen', !!on),
  roomOpenWindow: (type) => ipcRenderer.invoke('room:openWindow', type),
  hideWindow: () => ipcRenderer.send('win:hide'),
  closeWindow: () => ipcRenderer.send('win:close'),

  onState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('state:update', handler);
    return () => ipcRenderer.removeListener('state:update', handler);
  },
  onReminder: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('reminder:show', handler);
    return () => ipcRenderer.removeListener('reminder:show', handler);
  },
});
