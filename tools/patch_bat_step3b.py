# -*- coding: utf-8 -*-
# 修正 bat 第 3 步：用 %%~fI 归一化 APK 路径，避免 .. 段导致 lnk 缺 LinkInfo
import io

P = r'C:\Users\18824\WorkBuddy\2026-10-27-21-28-50\planquest\dist\PlanQuest-win64\一键创建快捷方式.bat'
s = io.open(P, encoding='gbk', newline='').read()

old = (
    'if exist "%APPDIR%..\\android\\PlanQuest-安卓版-v1.7.apk" (\r\n'
    '  powershell'
)
assert old in s, '未找到第 3 步 if 行'

new = (
    'if exist "%APPDIR%..\\android\\PlanQuest-安卓版-v1.7.apk" (\r\n'
    '  for %%I in ("%APPDIR%..\\android\\PlanQuest-安卓版-v1.7.apk") do set "APKPATH=%%~fI"\r\n'
    '  powershell'
)
s = s.replace(old, new, 1)

# TargetPath 改用归一化后的 %APKPATH%
old_t = "$lnk.TargetPath = '%APPDIR%..\\android\\PlanQuest-安卓版-v1.7.apk'; "
assert old_t in s, '未找到 TargetPath'
s = s.replace(old_t, "$lnk.TargetPath = '%APKPATH%'; ", 1)

# 工作目录同样归一化
old_w = "$lnk.WorkingDirectory = '%APPDIR%..\\android'; "
assert old_w in s, '未找到 WorkingDirectory'
s = s.replace(old_w, "$lnk.WorkingDirectory = '%~dp0..\\android'; ", 1)
# %~dp0 在引号字符串里不会被展开，改用预先归一化：再加一个 for
# 简化：直接复用 APKPATH 的父目录不可行，改为再归一化一次
s = s.replace(
    "$lnk.WorkingDirectory = '%~dp0..\\android'; ",
    "$wd = (Get-Item '%APKPATH%').DirectoryName; $lnk.WorkingDirectory = $wd; ",
    1,
)

s = s.replace('\r\n', '\n').replace('\n', '\r\n')
io.open(P, 'wb').write(s.encode('gbk'))
d = io.open(P, 'rb').read()
print('CRLF=%d 裸LF=%d' % (d.count(b'\r\n'), d.count(b'\n') - d.count(b'\r\n')))
print('APKPATH in:', '%%~fI' in d.decode('gbk'))
