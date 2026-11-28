# -*- coding: utf-8 -*-
"""把 Electron 缓存逐项移入回收站（FOF_ALLOWUNDO，可恢复）。
严格白名单：只清缓存目录与启动临时文件；用户数据一律不动。
"""
import ctypes
import os
from ctypes import wintypes

U = os.path.normpath(r'C:\Users\18824\AppData\Roaming\PlanQuest')
FO_DELETE = 3
FOF_ALLOWUNDO = 0x0040
FOF_NOCONFIRMATION = 0x0010
FOF_SILENT = 0x0004
FOF_NOERRORUI = 0x0400


class SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [
        ('hwnd', wintypes.HWND),
        ('wFunc', wintypes.UINT),
        ('pFrom', ctypes.c_void_p),
        ('pTo', ctypes.c_void_p),
        ('fFlags', ctypes.c_uint16),
        ('fAnyOperationsAborted', wintypes.BOOL),
        ('hNameMappings', ctypes.c_void_p),
        ('lpszProgressTitle', ctypes.c_void_p),
    ]


shell32 = ctypes.windll.shell32
shell32.SHFileOperationW.argtypes = [ctypes.POINTER(SHFILEOPSTRUCTW)]
shell32.SHFileOperationW.restype = ctypes.c_int


def trash(path):
    p = os.path.normpath(os.path.abspath(path))
    # create_unicode_buffer 自动追加一个终止符 → p + '\0' + '\0'（双 null 结尾）
    buf = ctypes.create_unicode_buffer(p + '\0')
    op = SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = FO_DELETE
    op.pFrom = ctypes.cast(buf, ctypes.c_void_p)
    op.pTo = None
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
    rc = shell32.SHFileOperationW(ctypes.byref(op))
    return rc, bool(op.fAnyOperationsAborted)


DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache',
        'DawnWebGPUCache', 'Shared Dictionary', 'blob_storage']
FILES = ['DevToolsActivePort', 'boot.log', 'focus.log', 'guard-elev.log',
         'focus.log.bak']  # 旧日志备份，同属缓存类残留
KEEP_DIRS = ['Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage', 'Network']
KEEP_FILES = ['data.json', 'Preferences', 'SharedStorage', 'ai-train.json', 'legion.json',
              'overwrite-vault.json', 'overwrite-vault.key']

def is_empty_dir(p):
    try:
        return os.path.isdir(p) and not any(os.scandir(p))
    except OSError:
        return False


targets = [os.path.join(U, d) for d in DIRS if os.path.isdir(os.path.join(U, d))]
targets += [os.path.join(U, f) for f in FILES if os.path.isfile(os.path.join(U, f))]

print('待清理 %d 项：' % len(targets))
for t in targets:
    print('  - ' + os.path.relpath(t, U))

fail = []
for i in range(0, len(targets), 10):          # 小批量：每批最多 10 项
    batch = targets[i:i + 10]
    for t in batch:
        # 空目录送回收站时 Windows 返回 rc=2（不生成回收站条目），但目录确实已移除
        empty = is_empty_dir(t)
        rc, aborted = trash(t)
        gone = not os.path.exists(t)
        ok = gone and not aborted and (rc == 0 or (rc == 2 and empty))
        status = 'OK' if ok else 'FAIL'
        if not ok:
            fail.append((t, rc, aborted, gone))
        print('  [%s] %-24s rc=%s aborted=%s gone=%s%s' %
              (status, os.path.basename(t), rc, aborted, gone, ' (空目录)' if empty else ''))
    # 每批后验证用户数据仍在
    for k in KEEP_DIRS:
        if os.path.isdir(os.path.join(U, k)) is False and k in ('IndexedDB', 'Local Storage'):
            print('  !! 用户数据目录丢失：' + k)
            fail.append((k, 'missing'))

print('\n=== 保留项复核 ===')
for k in KEEP_DIRS + KEEP_FILES:
    q = os.path.join(U, k)
    if os.path.exists(q):
        print('  KEEP OK  ' + k)
    else:
        print('  (不存在，跳过) ' + k)

print('\n=== 结果 ===')
print('失败项：', fail if fail else '无')
raise SystemExit(1 if fail else 0)
