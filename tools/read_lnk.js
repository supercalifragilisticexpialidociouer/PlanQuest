/* 读 .lnk 的目标 / 参数 / 图标（纯 JS，不走 COM） */
const fs = require('fs');

function readLnk(p) {
  const b = fs.readFileSync(p);
  if (b.readUInt32LE(0) !== 0x4c) throw new Error('bad magic');
  const flags = b.readUInt32LE(20);
  let off = 76;
  if (flags & 0x1) { const n = b.readUInt16LE(off); off += 2 + n; }
  let target = '';
  if (flags & 0x2) {
    const li = b.readUInt32LE(off);
    const hdr = b.readUInt32LE(off + 4);
    if (hdr >= 0x1c) {
      const lbp = b.readUInt32LE(off + 16);
      if (lbp) {
        let e = off + lbp;
        while (b[e] !== 0) e++;
        target = b.slice(off + lbp, e).toString('latin1');
      }
    }
    off += li;
  }
  const bits = [[0x4, 'name'], [0x8, 'rel'], [0x10, 'work'], [0x20, 'args'], [0x40, 'icon']];
  const out = { target, name: '', rel: '', work: '', args: '', icon: '' };
  let q = off;
  for (const [bit, key] of bits) {
    if (!(flags & bit)) continue;
    const cc = b.readUInt16LE(q);
    out[key] = b.slice(q + 2, q + 2 + cc * 2).toString('utf16le');
    q += 2 + cc * 2;
  }
  return out;
}

for (const p of process.argv.slice(2)) {
  try {
    console.log(p);
    console.log(JSON.stringify(readLnk(p), null, 1));
  } catch (e) {
    console.log('  读取失败:', e.message);
  }
}
