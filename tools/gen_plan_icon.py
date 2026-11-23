# -*- coding: utf-8 -*-
"""生成 .pqplan 专属文件图标：白纸文档 + 折角 + 蓝紫渐变勾选块。
输出 assets/icon-plan.ico（多尺寸帧）。"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 256

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# ---- 纸张：右上角斜切的圆角多边形 ----
paper_pts = [(56, 10), (150, 10), (202, 62), (202, 246), (56, 246)]
# 用 mask 画圆角纸：先画圆角矩形，再把右上角覆盖为折角形状
paper = Image.new('RGBA', (S, S), (0, 0, 0, 0))
pd = ImageDraw.Draw(paper)
pd.rounded_rectangle((56, 10, 202, 246), radius=14, fill=(255, 255, 255, 255))
# 切掉右上角：把 (150,10)-(202,62) 区域挖空
pd.polygon([(150, 10), (202, 10), (202, 62), (150, 10)], fill=(0, 0, 0, 0))
img.alpha_composite(paper)
# 描边
d = ImageDraw.Draw(img)
d.line([(56, 14), (56, 246)], fill=(205, 208, 216, 255), width=3)
d.line([(56, 246), (202, 246)], fill=(205, 208, 216, 255), width=3)
d.line([(202, 246), (202, 62)], fill=(205, 208, 216, 255), width=3)
# 折页
d.polygon([(150, 10), (150, 62), (202, 62)], fill=(225, 228, 235, 255))
d.line([(150, 10), (150, 62)], fill=(190, 194, 204, 255), width=2)
d.line([(150, 62), (202, 62)], fill=(190, 194, 204, 255), width=2)

# ---- 中央蓝紫渐变圆角方块 + 白色对勾 ----
bx0, by0, bx1, by1 = 88, 92, 172, 176
grad = Image.new('RGBA', (bx1 - bx0, by1 - by0), (0, 0, 0, 0))
c1 = (79, 125, 249)   # #4F7DF9
c2 = (139, 92, 246)   # #8B5CF6
w, h = grad.size
px = grad.load()
for y in range(h):
    for x in range(w):
        t = (x + y) / (w + h)
        r = int(c1[0] + (c2[0] - c1[0]) * t)
        g = int(c1[1] + (c2[1] - c1[1]) * t)
        b = int(c1[2] + (c2[2] - c1[2]) * t)
        px[x, y] = (r, g, b, 255)
mask = Image.new('L', (w, h), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=14, fill=255)
img.paste(grad, (bx0, by0), mask)

d = ImageDraw.Draw(img)
# 白勾（圆头粗线）
d.line([(104, 136), (122, 154)], fill=(255, 255, 255, 255), width=13)
d.line([(122, 154), (156, 116)], fill=(255, 255, 255, 255), width=13)
d.ellipse((97, 129, 111, 143), fill=(255, 255, 255, 255))
d.ellipse((115, 147, 129, 161), fill=(255, 255, 255, 255))
d.ellipse((149, 109, 163, 123), fill=(255, 255, 255, 255))

# ---- 输出多尺寸 ico ----
out = os.path.join(ROOT, 'assets', 'icon-plan.ico')
img.save(out, format='ICO', sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print('written', out, os.path.getsize(out), 'bytes')
