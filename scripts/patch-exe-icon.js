'use strict';
/* 给 PlanQuest.exe 换图标（纯 JS PE 资源编辑，同时更新版本信息）
 * 用法：node scripts/patch-exe-icon.js <源exe> <输出exe> <PlanQuest.ico路径>
 * 源 exe 正在运行也没关系：读出来改、写到新文件，等应用退出后替换。
 */
const fs = require('node:fs');
const { NtExecutable, NtExecutableResource } = require('pe-library');
const R = require('resedit');
const { Resource } = R;
const RData = R.Data;

const [, , srcExe, outExe, icoPath] = process.argv;
if (!srcExe || !outExe || !icoPath) {
  console.error('用法: node patch-exe-icon.js <源exe> <输出exe> <ico>');
  process.exit(1);
}

const exe = NtExecutable.from(fs.readFileSync(srcExe));
const res = NtExecutableResource.from(exe);

/* 解析 .ico（PNG 内嵌条目） */
const buf = fs.readFileSync(icoPath);
const count = buf.readUInt16LE(4);
const icons = [];
for (let i = 0; i < count; i++) {
  const o = 6 + i * 16;
  const len = buf.readUInt32LE(o + 8);
  const off = buf.readUInt32LE(o + 12);
  let w = buf[o];
  if (w === 0) w = 256;
  let h = buf[o + 1];
  if (h === 0) h = 256;
  icons.push(new RData.RawIconItem(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + len), w, h, buf.readUInt16LE(o + 6) || 32));
}
console.log('ico 条目:', icons.map((i) => `${i.width}x${i.height}`).join(', '));

/* 找到现有图标组，整体替换 */
const groups = Resource.IconGroupEntry.fromEntries(res.entries);
console.log('现有图标组:', groups.map((g) => `${g.id}@${g.lang}`).join(', ') || '(无)');
if (!groups.length) {
  console.error('exe 里没有图标组资源，无法就地替换');
  process.exit(1);
}
Resource.IconGroupEntry.replaceIconsForResource(res.entries, groups[0].id, groups[0].lang, icons);

/* 版本信息改成 PlanQuest 自己的 */
const vis = Resource.VersionInfo.fromEntries(res.entries);
if (vis.length) {
  const vi = vis[0];
  const langs = vi.getAvailableLanguages();
  const lang = langs.length ? langs[0] : { lang: 0x0409, codepage: 1200 };
  vi.setFileVersion('1.1.0', lang);
  vi.setProductVersion('1.1.0', lang);
  vi.setStringValues(lang, {
    ProductName: 'PlanQuest',
    FileDescription: 'PlanQuest 计划打卡',
    ProductVersion: '1.1.0',
    FileVersion: '1.1.0',
    OriginalFilename: 'PlanQuest.exe',
    InternalName: 'PlanQuest',
  });
  vi.outputToResourceEntries(res.entries);
  console.log('版本信息已更新 → 1.1.0');
} else {
  console.log('（exe 无版本信息资源，跳过）');
}

res.outputResource(exe);
fs.writeFileSync(outExe, Buffer.from(exe.generate()));
console.log('已生成:', outExe, fs.statSync(outExe).size, 'bytes');
