# -*- coding: utf-8 -*-
"""把变色帧 PNG 转成多尺寸 .ico，供 Windows 快捷方式直接引用。
产出：
  assets/icon-app.ico                     原色图标（= 帧 00），快捷方式"空闲"状态
  assets/ind-ico/frame-00..23.ico         24 帧变色图标，快捷方式"有任务"状态
快捷方式只引用这些固定文件，不再依赖 exe 路径，避免图标被写成 electron.exe。
"""
import os
import glob

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRAME_DIR = os.path.join(ROOT, 'assets', 'ind-frames')
OUT_DIR = os.path.join(ROOT, 'assets', 'ind-ico')
SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]


def to_ico(src, dst):
    im = Image.open(src).convert('RGBA')
    im.save(dst, format='ICO', sizes=SIZES)
    return os.path.getsize(dst)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    frames = sorted(glob.glob(os.path.join(FRAME_DIR, 'frame-*.png')))
    if not frames:
        raise SystemExit('缺少 assets/ind-frames 帧图，先跑 tools/gen_indicator_icons.py')
    total = 0
    for f in frames:
        name = os.path.splitext(os.path.basename(f))[0]
        dst = os.path.join(OUT_DIR, name + '.ico')
        total += to_ico(f, dst)
    print(f'生成 {len(frames)} 个帧 ico → {OUT_DIR}（{total // 1024} KB）')

    base = os.path.join(ROOT, 'assets', 'icon-app.ico')
    n = to_ico(frames[0], base)
    print(f'生成原色图标 → {base}（{n // 1024} KB）')


if __name__ == '__main__':
    main()
