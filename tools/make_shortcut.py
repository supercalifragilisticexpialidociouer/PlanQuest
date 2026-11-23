# -*- coding: utf-8 -*-
"""在桌面创建 PlanQuest 快捷方式（图标引用 exe 内嵌图标，与安卓/电脑统一）。

用法: python tools/make_shortcut.py
"""
import os
import sys
import win32com.client

DESKTOP = os.path.join(os.environ['USERPROFILE'], 'Desktop')
EXE = os.path.join(DESKTOP, 'planquest', 'dist', 'PlanQuest-win64', 'PlanQuest.exe')
LNK = os.path.join(DESKTOP, 'PlanQuest.lnk')

def main():
    if not os.path.isfile(EXE):
        print('EXE 不存在:', EXE)
        sys.exit(1)
    shell = win32com.client.Dispatch('WScript.Shell')
    sc = shell.CreateShortCut(LNK)
    sc.TargetPath = EXE
    sc.WorkingDirectory = os.path.dirname(EXE)
    sc.IconLocation = f'{EXE},0'  # exe 内嵌图标（已与安卓统一）
    sc.Description = 'PlanQuest 计划打卡'
    sc.WindowStyle = 1
    sc.Save()
    print('created:', LNK)
    # 回读校验
    chk = shell.CreateShortCut(LNK)
    print('  target:', chk.TargetPath)
    print('  icon  :', chk.IconLocation)
    print('  workdir:', chk.WorkingDirectory)

if __name__ == '__main__':
    main()
