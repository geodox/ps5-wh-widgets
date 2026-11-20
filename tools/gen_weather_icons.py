"""Draw the Weather widget's condition icons: white on transparent, 128 px.

    python tools/gen_weather_icons.py [out_dir]

Writes icon-<name>.png, and glyph.png (112 px, the widget's own icon), into
out_dir (default sample-widgets/weather). Shapes are
drawn at 4x and scaled down for smooth edges. Needs Pillow.
"""
import math
import os
import sys

from PIL import Image, ImageDraw

SIZE = 128
SS = 4                      # supersampling factor
S = SIZE * SS
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)


def canvas():
    im = Image.new('RGBA', (S, S), CLEAR)
    return im, ImageDraw.Draw(im)


def px(v):
    return int(round(v * SS))


def sun(d, cx, cy, r, rays=True):
    d.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], fill=WHITE)
    if not rays:
        return
    for i in range(8):
        a = i * math.pi / 4
        x1, y1 = cx + math.cos(a) * (r + 8), cy + math.sin(a) * (r + 8)
        x2, y2 = cx + math.cos(a) * (r + 20), cy + math.sin(a) * (r + 20)
        d.line([px(x1), px(y1), px(x2), px(y2)], fill=WHITE, width=px(7))
        d.ellipse([px(x1 - 3.5), px(y1 - 3.5), px(x1 + 3.5), px(y1 + 3.5)], fill=WHITE)
        d.ellipse([px(x2 - 3.5), px(y2 - 3.5), px(x2 + 3.5), px(y2 + 3.5)], fill=WHITE)


def moon(im, cx, cy, r):
    d = ImageDraw.Draw(im)
    d.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], fill=WHITE)
    cut = Image.new('L', im.size, 0)
    ImageDraw.Draw(cut).ellipse([px(cx - r * 0.35), px(cy - r * 1.15), px(cx + r * 1.45), px(cy + r * 0.65)], fill=255)
    im.paste(CLEAR, (0, 0), cut)


def cloud(d, x, y, w, punch=None):
    """A cloud whose bottom-left corner is at (x, y + h), w wide. With `punch`
    (an image), a transparent outline is cut first so it reads over a sun."""
    h = w * 0.55
    parts = [
        (x + w * 0.00, y + h * 0.45, x + w * 0.42, y + h * 1.00),
        (x + w * 0.18, y + h * 0.10, x + w * 0.68, y + h * 0.95),
        (x + w * 0.48, y + h * 0.30, x + w * 1.00, y + h * 1.00),
    ]
    base = (x + w * 0.20, y + h * 0.62, x + w * 0.80, y + h * 1.00)
    if punch is not None:
        m = Image.new('L', punch.size, 0)
        md = ImageDraw.Draw(m)
        g = 6
        for (a, b, c, e) in parts:
            md.ellipse([px(a - g), px(b - g), px(c + g), px(e + g)], fill=255)
        md.rectangle([px(base[0] - g), px(base[1] - g), px(base[2] + g), px(base[3] + g)], fill=255)
        punch.paste(CLEAR, (0, 0), m)
        d = ImageDraw.Draw(punch)
    for (a, b, c, e) in parts:
        d.ellipse([px(a), px(b), px(c), px(e)], fill=WHITE)
    d.rectangle([px(base[0]), px(base[1]), px(base[2]), px(base[3])], fill=WHITE)
    return y + h


def save(im, out, name, size=SIZE, file=None):
    im.resize((size, size), Image.LANCZOS).save(os.path.join(out, file or 'icon-%s.png' % name), optimize=True)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'sample-widgets', 'weather')
    os.makedirs(out, exist_ok=True)

    im, d = canvas(); sun(d, 64, 64, 24); save(im, out, 'sun')
    im, d = canvas(); moon(im, 64, 64, 38); save(im, out, 'moon')

    im, d = canvas(); sun(d, 46, 44, 18); cloud(d, 30, 50, 90, punch=im); save(im, out, 'partly-day')
    save(im, out, 'glyph', size=112, file='glyph.png')    # the widget's icon (Edit Widgets, title)
    im, d = canvas(); moon(im, 48, 44, 28); cloud(ImageDraw.Draw(im), 30, 50, 90, punch=im); save(im, out, 'partly-night')

    im, d = canvas(); cloud(d, 10, 32, 108); save(im, out, 'cloud')

    im, d = canvas()
    for i, (x1, x2) in enumerate([(18, 110), (10, 96), (26, 118), (14, 104)]):
        y = 34 + i * 20
        d.line([px(x1), px(y), px(x2), px(y)], fill=WHITE, width=px(9))
        for xx in (x1, x2):
            d.ellipse([px(xx - 4.5), px(y - 4.5), px(xx + 4.5), px(y + 4.5)], fill=WHITE)
    save(im, out, 'fog')

    im, d = canvas(); bottom = cloud(d, 12, 14, 104)
    for x in (36, 60, 84):
        d.line([px(x), px(bottom + 12), px(x - 8), px(bottom + 34)], fill=WHITE, width=px(8))
    save(im, out, 'rain')

    im, d = canvas(); bottom = cloud(d, 12, 14, 104)
    for x, dy in ((34, 18), (64, 30), (94, 18)):
        cy = bottom + dy
        for k in range(3):
            a = k * math.pi / 3
            dx, dyy = math.cos(a) * 9, math.sin(a) * 9
            d.line([px(x - dx), px(cy - dyy), px(x + dx), px(cy + dyy)], fill=WHITE, width=px(5))
    save(im, out, 'snow')

    im, d = canvas(); bottom = cloud(d, 12, 10, 104)
    d.polygon([px(70), px(bottom + 4), px(48), px(bottom + 34), px(64), px(bottom + 34),
               px(54), px(bottom + 58), px(84), px(bottom + 22), px(67), px(bottom + 22), px(78), px(bottom + 4)], fill=WHITE)
    save(im, out, 'storm')


if __name__ == '__main__':
    main()
