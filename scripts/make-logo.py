from PIL import Image, ImageDraw

S = 1024
INK = (34, 29, 21, 255)
PAPER = (247, 244, 238, 255)
LINE = (217, 210, 192, 255)
ACCENT = (242, 201, 107, 255)
SHADOW = (22, 17, 9, 255)

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=224, fill=INK)

def slat(x, y, w, h, accent_dot=False, shadow=True):
    if shadow:
        d.rounded_rectangle([x + 10, y + 16, x + w + 10, y + h + 16], radius=44, fill=SHADOW)
    d.rounded_rectangle([x, y, x + w, y + h], radius=44, fill=PAPER)
    tx = x + 46
    for i in range(3):
        ly = y + 52 + i * 46
        lw = int(w * 0.56)
        d.rounded_rectangle([tx, ly, tx + lw, ly + 14], radius=7, fill=LINE)
    if accent_dot:
        d.rounded_rectangle([x + w - 110, y + 52, x + w - 46, y + 116], radius=22, fill=ACCENT)

slat(180, 470, 672, 172)
slat(296, 300, 556, 172)
slat(412, 130, 440, 172, accent_dot=True)

img.save('/home/touhid/Documents/markdown/apps/desktop/src-tauri/icons/palimpsest-master.png')
def emit(size, path):
    img.resize((size, size), Image.LANCZOS).save(path)

ICONS = '/home/touhid/Documents/markdown/apps/desktop/src-tauri/icons'
emit(32, f'{ICONS}/32x32.png')
emit(128, f'{ICONS}/128x128.png')
emit(256, f'{ICONS}/128x128@2x.png')
emit(512, f'{ICONS}/icon.png')
HIC = '/home/touhid/.local/share/icons/hicolor'
emit(32, f'{HIC}/32x32/apps/palimpsest.png')
emit(128, f'{HIC}/128x128/apps/palimpsest.png')
emit(256, f'{HIC}/256x256@2x/apps/palimpsest.png')
print('icons written')
