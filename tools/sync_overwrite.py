# -*- coding: utf-8 -*-
"""全端同源同步：工作区源码 → web / 安卓 / 便携运行目录 / 桌面运行副本。

用法：python tools/sync_overwrite.py
只读校验：python tools/sync_overwrite.py --check

覆盖的功能：.pqplan 覆盖扣刺 + 五套皮肤利弊 + 数值心情 + 阿刺顶罪。
新增模块 aci-perk.js 必须在 pq-core.js / buddy.js 之前加载，脚本会强制校验顺序。
"""
import hashlib
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESKTOP = r'C:\Users\18824\Desktop\planquest'
EDRIVE = r'E:\planquest'
CHECK = '--check' in sys.argv


def p(*parts):
    return os.path.join(ROOT, *parts)


def md5(path):
    try:
        with open(path, 'rb') as f:
            return hashlib.md5(f.read()).hexdigest()
    except OSError:
        return '(missing)'


def label_of(d):
    if d.startswith(ROOT):
        return os.path.relpath(d, ROOT).replace('\\', '/')
    if d.startswith(DESKTOP):
        return 'DESKTOP/' + os.path.relpath(d, DESKTOP).replace('\\', '/')
    if d.startswith(EDRIVE):
        return 'E/' + os.path.relpath(d, EDRIVE).replace('\\', '/')
    return d


def copy(src, dst, label):
    if CHECK:
        a, b = md5(src), md5(dst)
        good = (a == b and a != '(missing)')
        print(('  OK    ' if good else '  MISS  ') + label + '  ' + a[:8] + ' / ' + b[:8])
        return good
    if not os.path.exists(src):
        print('  SKIP  ' + label + ' (源文件不存在)')
        return False
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        shutil.copyfile(src, dst)
    except PermissionError:
        # 某些同步盘 / 杀软会短暂锁住文件本身（但允许改名）；改名后重写即可。
        bak = dst + '.bak'
        if os.path.exists(bak):
            os.remove(bak)
        os.rename(dst, bak)
        try:
            shutil.copyfile(src, dst)
        except OSError:
            os.rename(bak, dst)
            raise
        os.remove(bak)
    print('  COPY  ' + label)
    return True


def write_text(path, text):
    """同 copy() 的改名 fallback：绕过杀软/同步盘对原文件的短暂写锁。"""
    try:
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(text)
    except PermissionError:
        bak = path + '.bak'
        if os.path.exists(bak):
            os.remove(bak)
        os.rename(path, bak)
        try:
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write(text)
        except OSError:
            os.rename(bak, path)
            raise
        os.remove(bak)


def patch_index(path, label):
    """intermediates 的 index.html 是移动版专用结构：核心模块必须在 core/pq-core.js 之前。"""
    try:
        with open(path, encoding='utf-8') as fh:
            s = fh.read()
    except OSError:
        if CHECK:
            print('  MISS  ' + label + ' (文件不存在)')
            return False
        return True
    tags = ['aci-perk.js', 'contract-fine.js', 'onboarding.js', 'plan-overwrite.js']
    anchor = '<script src="core/pq-core.js"></script>'
    insert = ('<script src="aci-perk.js"></script>\n  <script src="contract-fine.js"></script>\n'
              '  <script src="onboarding.js"></script>\n'
              '  <script src="plan-overwrite.js"></script>\n  ')
    ordered = (anchor in s and
               s.find('aci-perk.js') < s.find('contract-fine.js') < s.find('onboarding.js')
               < s.find('plan-overwrite.js') < s.find('core/pq-core.js'))
    if CHECK:
        print(('  OK    ' if ordered else '  MISS  ') + label + ' (script order)')
        return ordered
    if ordered:
        return True
    # 非校验模式：先清掉旧的引用，避免重复插
    for t in tags:
        s = s.replace('<script src="%s"></script>\n  ' % t, '')
        s = s.replace('<script src="%s"></script>' % t, '')
    if anchor in s:
        s = s.replace(anchor, insert + anchor, 1)
    else:
        s = s.replace('<script src="app.js"></script>', insert + '<script src="app.js"></script>', 1)
    write_text(path, s)
    print('  PATCH ' + label + ' (+aci-perk.js +contract-fine.js +onboarding.js +plan-overwrite.js 前置)')
    return True


def mirror_index(path, label):
    """普通端 index.html 直接由 src/renderer/index.html 覆盖，但必须含 aci-perk.js。"""
    try:
        with open(path, encoding='utf-8') as fh:
            s = fh.read()
    except OSError:
        return True
    has = 'aci-perk.js' in s and 'plan-overwrite.js' in s
    good = has and s.find('aci-perk.js') < s.find('buddy.js') and s.find('aci-perk.js') < s.find('app.js')
    if CHECK:
        print(('  OK    ' if good else '  MISS  ') + label + ' (aci-perk 前置)')
        return good
    return True


# ---------- 目标目录清单 ----------
RENDER_DIRS = [
    p('web'),
    p('android-app', 'www'),
    p('android-app', 'android', 'app', 'src', 'main', 'assets', 'public'),
    p('android-app', 'android', 'app', 'build', 'intermediates', 'assets', 'debug', 'public'),
    p('dist', 'PlanQuest-win64', 'resources', 'app', 'src', 'renderer'),
    os.path.join(DESKTOP, 'web'),
    os.path.join(DESKTOP, 'android-app', 'www'),
    os.path.join(DESKTOP, 'android-app', 'android', 'app', 'src', 'main', 'assets', 'public'),
    os.path.join(DESKTOP, 'android-app', 'android', 'app', 'build', 'intermediates', 'assets', 'debug', 'public'),
    os.path.join(DESKTOP, 'dist', 'PlanQuest-win64', 'resources', 'app', 'src', 'renderer'),
    os.path.join(DESKTOP, 'src', 'renderer'),
    os.path.join(EDRIVE, 'web'),
    os.path.join(EDRIVE, 'android-app', 'www'),
    os.path.join(EDRIVE, 'android-app', 'android', 'app', 'src', 'main', 'assets', 'public'),
    os.path.join(EDRIVE, 'android-app', 'android', 'app', 'build', 'intermediates', 'assets', 'debug', 'public'),
    os.path.join(EDRIVE, 'dist', 'PlanQuest-win64', 'resources', 'app', 'src', 'renderer'),
    os.path.join(EDRIVE, 'src', 'renderer'),
]
RENDER_FILES = ['app.js', 'styles.css', 'buddy.js', 'api-bridge.js', 'buddy3d.js',
                'aci-skin.js', 'aci-perk.js', 'contract-fine.js', 'onboarding.js', 'msg-center.js',
                'plan-overwrite.js', 'ala-llm.js', 'ala-act.js', 'index.html']

MAIN_DIRS = [
    p('dist', 'PlanQuest-win64', 'resources', 'app', 'src'),
    os.path.join(DESKTOP, 'dist', 'PlanQuest-win64', 'resources', 'app', 'src'),
    os.path.join(DESKTOP, 'src'),
    os.path.join(EDRIVE, 'dist', 'PlanQuest-win64', 'resources', 'app', 'src'),
    os.path.join(EDRIVE, 'src'),
]
MAIN_FILES = ['main.js', 'preload.js', 'aci-core.js', 'aci-skin.js', 'aci-perk.js',
              'contract-fine.js', 'plan-overwrite.js', 'plan-guard.js',
              'version-hash.js', 'ala-llm.js']

CORE_DIRS = [
    p('android-app', 'www', 'core'),
    p('android-app', 'android', 'app', 'src', 'main', 'assets', 'public', 'core'),
    p('android-app', 'android', 'app', 'build', 'intermediates', 'assets', 'debug', 'public', 'core'),
    p('dist', 'PlanQuest-win64', 'resources', 'app', 'src', 'renderer', 'core'),
    os.path.join(DESKTOP, 'android-app', 'www', 'core'),
    os.path.join(DESKTOP, 'android-app', 'android', 'app', 'src', 'main', 'assets', 'public', 'core'),
    os.path.join(DESKTOP, 'android-app', 'android', 'app', 'build', 'intermediates', 'assets', 'debug', 'public', 'core'),
    os.path.join(DESKTOP, 'dist', 'PlanQuest-win64', 'resources', 'app', 'src', 'renderer', 'core'),
    os.path.join(DESKTOP, 'web', 'core'),
    os.path.join(EDRIVE, 'android-app', 'www', 'core'),
    os.path.join(EDRIVE, 'android-app', 'android', 'app', 'src', 'main', 'assets', 'public', 'core'),
    os.path.join(EDRIVE, 'android-app', 'android', 'app', 'build', 'intermediates', 'assets', 'debug', 'public', 'core'),
    os.path.join(EDRIVE, 'dist', 'PlanQuest-win64', 'resources', 'app', 'src', 'renderer', 'core'),
    os.path.join(EDRIVE, 'web', 'core'),
]

EXTRA_FILES = [
    ('dev-tests/test-plan-overwrite.js', 'dev-tests/test-plan-overwrite.js'),
    ('dev-tests/test-aci-perk.js', 'dev-tests/test-aci-perk.js'),
    ('dev-tests/test-skin-mood.js', 'dev-tests/test-skin-mood.js'),
    ('dev-tests/test-contract-fine.js', 'dev-tests/test-contract-fine.js'),
    ('dev-tests/skin-mood-card.html', 'dev-tests/skin-mood-card.html'),
    ('dev-tests/test-aci-voice.js', 'dev-tests/test-aci-voice.js'),
    ('dev-tests/test-msg-center.js', 'dev-tests/test-msg-center.js'),
    ('dev-tests/test-identity-chat.js', 'dev-tests/test-identity-chat.js'),
    ('dev-tests/test-plan-file.js', 'dev-tests/test-plan-file.js'),
    ('dev-tests/overwrite-punish-card.html', 'dev-tests/overwrite-punish-card.html'),
    ('tools/sync_overwrite.py', 'tools/sync_overwrite.py'),
    ('tools/repack_portable.py', 'tools/repack_portable.py'),
]


# 安装助手 / 更新清单 / 说明文档：桌面副本与 E 盘三端副本都要一致
SHARED_FILES = [
    '使用说明.txt',
    'dist/使用说明.txt',
    'dist/PlanQuest-win64/使用说明.txt',
    'tools/PlanQuest-Assistant.iss',
    'tools/lang/ChineseSimplified.isl',
    'tools/build-manifest.js',
    'tools/repack_portable.py',
    'tools/sync_overwrite.py',
    'dist/version.json',
    'dist/version.hash',
    'dist/PlanQuest-win64-portable.zip',
    'dist/releases/PlanQuest-win64-portable-backup.zip',
    'dist/releases/PlanQuest-安装助手.exe',
    'dist/releases/assistant-sources.txt',
    'tools/replace-release-assets.js',
]


def main():
    all_ok = True
    print('=== 0. 生成渲染层 UMD 副本（src/*.js → src/renderer/*.js） ===')
    for f in ['plan-overwrite.js', 'aci-perk.js', 'contract-fine.js', 'onboarding.js', 'ala-llm.js']:
        all_ok &= copy(p('src', f), p('src', 'renderer', f), 'src/renderer/' + f)

    print('=== 1. 渲染层镜像（含桌面运行副本） ===')
    for d in RENDER_DIRS:
        rel = label_of(d)
        for f in RENDER_FILES:
            if f == 'index.html' and 'intermediates' in d:
                all_ok &= patch_index(os.path.join(d, f), rel + '/index.html')
                continue
            ok = copy(p('src', 'renderer', f), os.path.join(d, f), rel + '/' + f)
            all_ok &= ok
            if f == 'index.html' and ok:
                all_ok &= mirror_index(os.path.join(d, f), rel + '/index.html')

    print('=== 2. 便携版 / 桌面副本主进程 ===')
    for d in MAIN_DIRS:
        rel = label_of(d)
        for f in MAIN_FILES:
            all_ok &= copy(p('src', f), os.path.join(d, f), rel + '/' + f)

    print('=== 3. Web / 安卓核心 pq-core.js ===')
    for d in CORE_DIRS:
        rel = label_of(d)
        all_ok &= copy(p('web', 'core', 'pq-core.js'), os.path.join(d, 'pq-core.js'), rel + '/pq-core.js')

    print('=== 4. 新增测试 / 工具同步到桌面副本 ===')
    for src_rel, dst_rel in EXTRA_FILES:
        all_ok &= copy(p(*src_rel.split('/')), os.path.join(DESKTOP, *dst_rel.split('/')),
                       'DESKTOP/' + dst_rel)

    print('=== 4b. 安装助手 / 更新清单 / 说明 → 桌面 + E 盘 ===')
    for target_root, tag in [(DESKTOP, 'DESKTOP'), (EDRIVE, 'E')]:
        for rel in SHARED_FILES:
            all_ok &= copy(p(*rel.split('/')), os.path.join(target_root, *rel.split('/')),
                           tag + '/' + rel)

    print('=== 5. 关键文件 md5 汇总（工作区源） ===')
    for f in ['main.js', 'preload.js', 'aci-core.js', 'aci-perk.js', 'plan-overwrite.js',
              'renderer/app.js', 'renderer/buddy.js', 'renderer/index.html',
              'renderer/styles.css', 'renderer/api-bridge.js', 'renderer/aci-perk.js', 'renderer/onboarding.js']:
        src = p('src', *f.split('/'))
        print('  %-40s %s' % (f, md5(src)[:12]))

    print('\n' + ('校验通过' if all_ok else '存在不一致，请重跑同步'))
    return 0 if all_ok else 1


if __name__ == '__main__':
    sys.exit(main())
