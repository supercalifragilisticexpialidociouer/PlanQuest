const fs = require('fs');
const path = require('path');

global.window = {};
require(path.join(__dirname, '..', 'web', 'share.js'));

const QR = global.window.PQShare.__qr;
const url = 'https://planquest-pwa.app.workbuddy.host';
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'qr-ref.json'), 'utf8'));

let allOk = true;
for (let k = 0; k < 8; k++) {
  const mine = QR.build(url, k);
  const theirs = ref.masks[String(k)];
  if (mine.length !== theirs.length) {
    console.log(`mask ${k}: 尺寸不一致 ${mine.length} vs ${theirs.length}`);
    allOk = false;
    continue;
  }
  let diff = 0;
  for (let r = 0; r < mine.length; r++) {
    for (let c = 0; c < mine.length; c++) {
      if ((mine[r][c] ? 1 : 0) !== theirs[r][c]) diff++;
    }
  }
  console.log(`mask ${k}: 差异 ${diff} 个模块 ${diff === 0 ? '✅' : '❌'}`);
  if (diff !== 0) allOk = false;
}

// 自动选掩码的结果也打印出来，便于人工核对
const auto = QR.build(url);
console.log(`自动选掩码 -> 尺寸 ${auto.length}（参考 version=${ref.version}, size=${auto.length}）`);
console.log(allOk ? '\n全部掩码逐位一致 ✅' : '\n存在差异 ❌');
process.exit(allOk ? 0 : 1);
