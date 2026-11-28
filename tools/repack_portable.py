# -*- coding: utf-8 -*-
"""重新打包便携版 zip，并刷新 dist/version.json 与 dist/version.hash 的 size / sha256。

用法：python tools/repack_portable.py
"""
import hashlib
import json
import os
import shutil
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
SRC_DIR = os.path.join(DIST, 'PlanQuest-win64')
ZIP = os.path.join(DIST, 'PlanQuest-win64-portable.zip')
TMP = ZIP + '.tmp'


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


# 绿色包必须是「初始状态」：源码/模型/资源可以进，任何用户数据都不行。
FORBIDDEN_DIRS = {'userdata', 'user-data', 'cache', 'caches', 'logs', 'sessions',
                  'local storage', 'components', 'crashdumps', 'code cache'}
FORBIDDEN_FILES = {'data.json', 'settings.json', 'state.json', 'user.json',
                   'profile.json', '.env', 'credentials.json', 'token.json',
                   'access_token.txt', 'assistant-sources.txt'}
FORBIDDEN_SUFFIXES = ('.pqplan', '.log', '.tmp', '.bak', '.swp', '.crash')


def assert_clean_source():
    bad = []
    for base, dirs, files in os.walk(SRC_DIR):
        dirs[:] = [d for d in dirs if d.lower() not in FORBIDDEN_DIRS]
        for name in files:
            low = name.lower()
            if low in FORBIDDEN_FILES or low.endswith(FORBIDDEN_SUFFIXES):
                bad.append(os.path.relpath(os.path.join(base, name), SRC_DIR))
    if bad:
        raise SystemExit('打包被拒绝：运行目录含用户数据/临时文件 → ' + ', '.join(bad[:20]))
    print('clean check: 无 data.json / 缓存 / 日志 / 凭据 / .pqplan，初始状态 OK')


def main():
    if not os.path.isdir(SRC_DIR):
        raise SystemExit('缺少运行目录：' + SRC_DIR)
    assert_clean_source()
    n = 0
    with zipfile.ZipFile(TMP, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for base, dirs, files in os.walk(SRC_DIR):
            dirs.sort()
            for f in sorted(files):
                full = os.path.join(base, f)
                rel = os.path.relpath(full, DIST).replace('\\', '/')
                z.write(full, rel)
                n += 1
    shutil.move(TMP, ZIP)
    size = os.path.getsize(ZIP)
    sha = sha256_of(ZIP)
    print('zip entries = %d, size = %d, sha256 = %s' % (n, size, sha))

    vj = os.path.join(DIST, 'version.json')
    with open(vj, encoding='utf-8') as f:
        v = json.load(f)
    v['releasedAt'] = '2026-11-25'
    v['notes'] = '安装助手全中文向导 + ZIP 原样完整解压 + 快捷方式指向真实 exe 并使用软件图标；新手引导浅色主题按钮修复；ZIP 无用户数据（初始状态）；阿刺五套皮肤心情/顶罪；.pqplan 覆盖审讯与阶梯扣刺'
    v['portable']['size'] = size
    v['portable']['sha256'] = sha
    with open(vj, 'w', encoding='utf-8') as f:
        json.dump(v, f, ensure_ascii=False, indent=2)
        f.write('\n')

    vh = os.path.join(DIST, 'version.hash')
    with open(vh, 'w', encoding='utf-8') as f:
        json.dump({'version': v['version'], 'hash': sha}, f, ensure_ascii=False)
        f.write('\n')
    print('version.json / version.hash 已刷新（version=%s）' % v['version'])


if __name__ == '__main__':
    main()
