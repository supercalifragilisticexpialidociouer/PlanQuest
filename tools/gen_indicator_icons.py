# -*- coding: utf-8 -*-
"""生成「顺滑变色」图标帧序列：色相整体连续旋转，形状不变。
窗口/任务栏每 120ms 换一帧 → 约 2.9 秒一圈的彩虹流转动画。
产出（assets/）：
  ind-frames/frame-00.png .. frame-23.png   24 帧动画（frame-00 = 原始颜色）
  icon-ind-0/1/2.ico                        三色多尺寸 ico（桌面快捷方式步进用）
  icon-ind-1.png / icon-ind-2.png           橙绿 / 紫粉静态版（保留给测试与预览）
"""
import colorsys
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'icon.png')
FRAMES = 24


def rotate_hue(im, rot):
    """整体色相旋转 rot 度，保持饱和度/明度与透明通道。"""
    w, h = im.size
    px = im.load()
    out = im.copy()
    po = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 8:
                continue
            hh, ss, vv = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            nr, ng, nb = colorsys.hsv_to_rgb(((hh * 360 + rot) % 360) / 360, ss, vv)
            po[x, y] = (round(nr * 255), round(ng * 255), round(nb * 255), a)
    return out


def make_ico(images, path):
    largest = max(images, key=lambda s: s[0])[1]
    largest.save(path, format='ICO', sizes=[(s, s) for s, _ in images])


def main():
    src = Image.open(SRC).convert('RGBA')

    # 1) 动画帧序列（均匀 360° 旋转，frame-00 即原色）
    fdir = os.path.join(ROOT, 'assets', 'ind-frames')
    os.makedirs(fdir, exist_ok=True)
    for k in range(FRAMES):
        rot = 360.0 * k / FRAMES
        f = rotate_hue(src, rot)
        f.save(os.path.join(fdir, f'frame-{k:02d}.png'))
    print(f'frames: {FRAMES} -> {fdir}')

    # 2) 静态两色（参考图配色，供预览/测试）
    #    原图渐变 TL 230° -> BR 181°；按几何对角线位置重映射到目标渐变
    w, h = src.size
    px = src.load()

    def remap(hue_tl, hue_br):
        out = src.copy()
        po = out.load()
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                if a < 8:
                    continue
                hh, ss, vv = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
                t = (x + y) / (w + h - 2)
                nr, ng, nb = colorsys.hsv_to_rgb((((hue_tl + (hue_br - hue_tl) * t) % 360) / 360), ss, vv)
                po[x, y] = (round(nr * 255), round(ng * 255), round(nb * 255), a)
        return out

    v1 = remap(27, 97)     # 橙 -> 绿
    v2 = remap(259, 360)   # 紫 -> 粉红
    v1.save(os.path.join(ROOT, 'assets', 'icon-ind-1.png'))
    v2.save(os.path.join(ROOT, 'assets', 'icon-ind-2.png'))

    # 3) 三色 ico（快捷方式步进用：0=原色 1=橙绿 2=紫粉）
    sizes = [256, 128, 64, 48, 32, 16]
    for i, im in enumerate([src, v1, v2]):
        make_ico([(s, im.resize((s, s), Image.LANCZOS)) for s in sizes],
                 os.path.join(ROOT, 'assets', f'icon-ind-{i}.ico'))
    print('icos: icon-ind-0/1/2.ico')


if __name__ == '__main__':
    main()
