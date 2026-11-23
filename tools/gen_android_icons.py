# -*- coding: utf-8 -*-
"""用桌面版图标 (assets/icon.png) 统一生成安卓全套启动图标。

产物（直接覆盖 android/app/src/main/res/ 下各密度）：
  mipmap-*/ic_launcher.png           方形圆角原图缩放
  mipmap-*/ic_launcher_round.png     圆形遮罩版
  mipmap-*/ic_launcher_foreground.png 108dp 自适应前景（内容居中占 66%）

用法: python tools/gen_android_icons.py
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'icon.png')
RES = os.path.join(ROOT, 'android-app', 'android', 'app', 'src', 'main', 'res')

DENSITIES = {
    'mipmap-mdpi': 48,
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192,
}

def circle_mask(size):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.ellipse((0, 0, size - 1, size - 1), fill=255)
    return m

def main():
    icon = Image.open(SRC).convert('RGBA')
    assert icon.size[0] == icon.size[1], 'icon must be square'
    for folder, side in DENSITIES.items():
        out = os.path.join(RES, folder)
        os.makedirs(out, exist_ok=True)
        big = icon.resize((side, side), Image.LANCZOS)

        # 1) 普通启动图标：原样缩放（自带圆角 + 透明边角）
        big.save(os.path.join(out, 'ic_launcher.png'))

        # 2) 圆形启动图标：内切圆遮罩
        round_img = Image.new('RGBA', (side, side), (0, 0, 0, 0))
        round_img.paste(big, (0, 0), circle_mask(side))
        round_img.save(os.path.join(out, 'ic_launcher_round.png'))

        # 3) 自适应前景：108dp 画布，内容占 66% 居中（xxxhdpi=432）
        fg_side = int(side * 2.25)  # 48→108, 192→432
        canvas = Image.new('RGBA', (fg_side, fg_side), (0, 0, 0, 0))
        inner = int(fg_side * 0.66)
        shrunk = icon.resize((inner, inner), Image.LANCZOS)
        off = (fg_side - inner) // 2
        canvas.paste(shrunk, (off, off), shrunk)
        canvas.save(os.path.join(out, 'ic_launcher_foreground.png'))

        print(f'{folder}: ic_launcher={side}px round={side}px foreground={fg_side}px')

    print('DONE')

if __name__ == '__main__':
    main()
