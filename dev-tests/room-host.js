/* 测试用：起一个真实的电脑版房间服务（复用 src/study-room.js），给 Java / JS 客户端连 */
'use strict';
const room = require('../src/study-room.js');

room.setEmitter((e) => {
  const json = JSON.stringify(e);
  console.log('[host]', json.length > 240 ? json.slice(0, 240) + '…' : json);
});

(async () => {
  const res = await room.createRoom({ name: '房主', avatar: '🙂', type: 'study' });
  if (!res.ok) {
    console.error('[host] 开房失败', res);
    process.exit(1);
  }
  console.log('[host] ready code=' + res.code + ' port=' + res.port + ' ip=' + res.ip);
  process.on('SIGTERM', () => process.exit(0));
})();
