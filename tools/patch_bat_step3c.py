# -*- coding: utf-8 -*-
# 修正：if 块内需要延迟展开 !APKPATH!，并开启 EnableDelayedExpansion
import io

P = r'C:\Users\18824\WorkBuddy\2026-10-27-21-28-50\planquest\dist\PlanQuest-win64\一键创建快捷方式.bat'
s = io.open(P, encoding='gbk', newline='').read()

s = s.replace('setlocal EnableExtensions\r\n', 'setlocal EnableExtensions EnableDelayedExpansion\r\n', 1)
assert 'EnableDelayedExpansion' in s

n = s.count("%APKPATH%")
s = s.replace("'%APKPATH%'", "'!APKPATH!'")
print('replaced APKPATH refs:', n)

s = s.replace('\r\n', '\n').replace('\n', '\r\n')
io.open(P, 'wb').write(s.encode('gbk'))
d = io.open(P, 'rb').read()
print('CRLF=%d 裸LF=%d' % (d.count(b'\r\n'), d.count(b'\n') - d.count(b'\r\n')))
