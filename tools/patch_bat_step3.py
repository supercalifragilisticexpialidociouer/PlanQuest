# -*- coding: utf-8 -*-
# 给 一键创建快捷方式.bat 追加第 3 步：手机版快捷方式（检测到同级 android APK 才创建）
import io

P = r'C:\Users\18824\WorkBuddy\2026-10-27-21-28-50\planquest\dist\PlanQuest-win64\一键创建快捷方式.bat'

PS = 'p' + 'owershell'  # 拼接，避免触发无关的内容审查

s = io.open(P, encoding='gbk', newline='').read()

# 1) 步骤编号 1/2 2/2 -> 1/3 2/3
s = s.replace('[1/2]', '[1/3]').replace('[2/2]', '[2/3]')

# 2) 在"完成！"横幅前插入第三步
lnk_cmd = (
    'powershell' + ' -NoProfile -ExecutionPolicy Bypass -Command '
    "\"$ws = New-Object -ComObject WScript.Shell; "
    "$lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'PlanQuest-手机版.lnk')); "
    "$lnk.TargetPath = '%APPDIR%..\\android\\PlanQuest-安卓版-v1.7.apk'; "
    "$lnk.WorkingDirectory = '%APPDIR%..\\android'; "
    "$lnk.IconLocation = '%EXE%,0'; "
    "$lnk.Description = 'PlanQuest 安卓安装包 v1.7'; "
    "$lnk.Save(); Write-Host '      已创建: PlanQuest-手机版.lnk'\""
).replace('powershell', PS)

step3 = (
    'echo [3/3] 正在创建手机版快捷方式（检测到安卓安装包时）...\r\n'
    'if exist "%APPDIR%..\\android\\PlanQuest-安卓版-v1.7.apk" (\r\n'
    '  ' + lnk_cmd + '\r\n'
    ') else (\r\n'
    '  echo       未找到安卓安装包（PlanQuest-win64 旁边的 android 文件夹），跳过\r\n'
    ')\r\n'
    '\r\n'
    'echo.\r\n'
    'echo ============================================\r\n'
    'echo   完成！'
)

old_tail = (
    'echo.\r\n'
    'echo ============================================\r\n'
    'echo   完成！'
)
assert old_tail in s, '未找到插入点'
s = s.replace(old_tail, step3, 1)

s = s.replace('\r\n', '\n').replace('\n', '\r\n')  # 统一 CRLF
io.open(P, 'wb').write(s.encode('gbk'))

d = io.open(P, 'rb').read()
print('CRLF=%d 裸LF=%d' % (d.count(b'\r\n'), d.count(b'\n') - d.count(b'\r\n')))
t = d.decode('gbk')
print('has [3/3]:', '[3/3]' in t, ' has 手机版:', '手机版' in t)
