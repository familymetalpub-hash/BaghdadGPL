# -*- coding: utf-8 -*-
"""
Roll Up FBM Automatisme — 100cm x 200cm @ 150 DPI (5906 x 11811 px)
Theme: blue/white clean technical. Minimal AR/FR text. No phone numbers.
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
import arabic_reshaper
from bidi.algorithm import get_display

BASE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(BASE, "fonts")
ASSETS = os.path.join(BASE, "assets")
OUT = os.path.join(BASE, "output")
os.makedirs(OUT, exist_ok=True)

W, H = 5906, 11811  # 100x200cm @150dpi
NAVY = (11, 42, 94)
STEEL = (27, 95, 170)
LIGHT_BLUE = (159, 184, 232)
ORANGE = (238, 123, 48)
DARK = (23, 33, 52)
GRAY = (74, 85, 104)
WHITE = (255, 255, 255)

def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)

F_ANTON = lambda s: font("Anton-Regular.ttf", s)
F_BLACK = lambda s: font("IBMPlexSansArabic-Bold.ttf", s)
F_BOLD = lambda s: font("IBMPlexSansArabic-Bold.ttf", s)
F_MED = lambda s: font("IBMPlexSansArabic-Medium.ttf", s)
F_SEMI = lambda s: font("IBMPlexSansArabic-SemiBold.ttf", s)

def ar(text):
    return get_display(arabic_reshaper.reshape(text))

def draw_spaced(draw, xy, text, fnt, fill, tracking=0, anchor="mm"):
    """Draw text with letter tracking. Anchor: mm (center) or lm (left-middle)."""
    widths = [draw.textlength(ch, font=fnt) for ch in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x, y = xy
    if anchor == "mm":
        x -= total / 2
    for ch, wch in zip(text, widths):
        draw.text((x, y), ch, font=fnt, fill=fill, anchor="lm")
        x += wch + tracking
    return total

# ---------------- Background photo ----------------
print("Loading background...", flush=True)
bg = Image.open(os.path.join(ASSETS, "bg-light-x4.png")).convert("RGB")
bg = bg.resize((W, H), Image.LANCZOS)
bg = ImageEnhance.Color(bg).enhance(1.07)
bg = ImageEnhance.Contrast(bg).enhance(1.04)
bg = bg.filter(ImageFilter.UnsharpMask(radius=6, percent=60, threshold=2))
canvas = bg.convert("RGBA")

# ---------------- Gradient overlays ----------------
print("Overlays...", flush=True)
yy = np.arange(H, dtype=np.float32)
# top white gradient: solid -> transparent (0 .. 2700)
a_top = np.clip((2700 - yy) / 2700, 0, 1) ** 1.15
# bottom navy gradient: transparent -> solid (8650 .. 10050)
a_bot = np.clip((yy - 8650) / (10050 - 8650), 0, 1) ** 1.1

white_layer = np.zeros((H, W, 4), dtype=np.float32)
white_layer[..., 0:3] = 255
white_layer[..., 3] = (a_top * 255)[:, None] * np.ones(W)
navy_layer = np.zeros((H, W, 4), dtype=np.float32)
navy_layer[..., 0] = NAVY[0]; navy_layer[..., 1] = NAVY[1]; navy_layer[..., 2] = NAVY[2]
navy_layer[..., 3] = (a_bot * 255)[:, None] * np.ones(W)

canvas = Image.alpha_composite(canvas, Image.fromarray(white_layer.astype(np.uint8), "RGBA"))
canvas = Image.alpha_composite(canvas, Image.fromarray(navy_layer.astype(np.uint8), "RGBA"))
draw = ImageDraw.Draw(canvas)

# solid top strip + solid bottom base (hidden part of rollup stand)
draw.rectangle([0, 0, W, 120], fill=NAVY + (255,))
draw.rectangle([0, 10050, W, H], fill=NAVY + (255,))
draw.rectangle([0, H - 620, W, H], fill=(7, 27, 61, 255))  # ~10cm hidden in base
draw.rectangle([0, 10050, W, 10090], fill=ORANGE + (255,))  # orange divider

# ---------------- Header ----------------
print("Header...", flush=True)
cx = W / 2
draw_spaced(draw, (cx, 800), "FBM", F_ANTON(760), NAVY, tracking=30)
draw_spaced(draw, (cx, 1330), "AUTOMATISME", F_ANTON(172), STEEL, tracking=60)
# orange rule + diamond
draw.line([(cx - 850, 1520), (cx + 850, 1520)], fill=ORANGE + (255,), width=22)
d = 46
draw.polygon([(cx, 1520 - d), (cx + d, 1520), (cx, 1520 + d), (cx - d, 1520)], fill=ORANGE + (255,))
# tagline pill
tag = ar("تركيب • صيانة • تصنيع  |  INSTALLATION • MAINTENANCE")
pill_font = F_BOLD(104)
tw = draw.textlength(tag, font=pill_font)
pill_w, pill_h, pill_y = tw + 340, 230, 1770
draw.rounded_rectangle([cx - pill_w / 2, pill_y - pill_h / 2, cx + pill_w / 2, pill_y + pill_h / 2],
                       radius=115, fill=NAVY + (255,))
draw.text((cx, pill_y - 8), tag, font=pill_font, fill=WHITE + (255,), anchor="mm")

# ---------------- Icons ----------------
def icon_verin(dr, ox, oy, s, col):
    # piston arm diagonal with mounts
    dr.line([(ox, oy + s * .72), (ox + s, oy + s * .28)], fill=col, width=int(s * .13))
    dr.rectangle([ox + s * .38, oy + s * .30, ox + s * .66, oy + s * .52], fill=col)
    dr.rectangle([ox - s * .06, oy + s * .60, ox + s * .14, oy + s * .92], fill=col)
    dr.rectangle([ox + s * .86, oy + s * .08, ox + s * 1.06, oy + s * .40], fill=col)

def icon_sliding(dr, ox, oy, s, col):
    # gate + arrow
    dr.rectangle([ox, oy, ox + s, oy + s * .52], outline=col, width=int(s * .09))
    for i in range(1, 4):
        x = ox + s * i / 4
        dr.line([(x, oy), (x, oy + s * .52)], fill=col, width=int(s * .06))
    ay = oy + s * .82
    dr.line([(ox + s * .05, ay), (ox + s * .95, ay)], fill=col, width=int(s * .10))
    dr.polygon([(ox + s * .95, ay - s * .16), (ox + s * 1.12, ay), (ox + s * .95, ay + s * .16)], fill=col)

def icon_barrier(dr, ox, oy, s, col):
    # post + striped arm
    dr.rectangle([ox, oy + s * .18, ox + s * .20, oy + s], fill=col)
    dr.rectangle([ox + s * .14, oy, ox + s * 1.05, oy + s * .26], fill=col)
    # stripes (cut by drawing navy slits? instead draw arm outline + stripe lines)
    for i in range(5):
        x0 = ox + s * (.20 + i * .17)
        dr.line([(x0, oy + s * .26), (x0 + s * .08, oy)], fill=(11, 42, 94), width=int(s * .05))

def icon_shutter(dr, ox, oy, s, col):
    dr.rectangle([ox, oy, ox + s, oy + s], outline=col, width=int(s * .09))
    for i in range(1, 6):
        y = oy + s * i / 6
        dr.line([(ox + s * .08, y), (ox + s * .92, y)], fill=col, width=int(s * .055))
    dr.rectangle([ox + s * .05, oy + s * .86, ox + s * .95, oy + s * .99], fill=col)

def icon_slats(dr, ox, oy, s, col):
    # stacked manufacturing slats
    for i in range(3):
        y0 = oy + i * s * .30
        dr.rectangle([ox + (0 if i % 2 == 0 else s * .12), y0,
                      ox + s * (.88 if i % 2 == 0 else 1.0), y0 + s * .18], fill=col)
    dr.ellipse([ox + s * .62, oy + s * .78, ox + s * 1.02, oy + s * 1.14], outline=col, width=int(s * .08))

SERVICES = [
    ("VÉRIN", "موتور للأبواب المفصلية", icon_verin),
    ("COULISSANT", "أبواب منزلقة أوتوماتيكية", icon_sliding),
    ("BARRIÈRE", "حواجز أوتوماتيكية", icon_barrier),
    ("RIDEAUX MÉTALLIQUES", "ستائر معدنية أوتوماتيكية", icon_shutter),
    ("FABRICATION LAMES", "تصنيع شرائح الستائر", icon_slats),
]

# ---------------- Cards ----------------
print("Cards...", flush=True)
margin = 300
card_w = W - 2 * margin
card_h = 1240
gap = 130
y0 = 2400
shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
sh_d = ImageDraw.Draw(shadow)
cards_y = []
for i in range(5):
    yt = y0 + i * (card_h + gap)
    cards_y.append(yt)
    sh_d.rounded_rectangle([margin, yt + 46, margin + card_w, yt + card_h + 46], radius=90, fill=(10, 25, 60, 90))
shadow = shadow.filter(ImageFilter.GaussianBlur(55))
canvas = Image.alpha_composite(canvas, shadow)
draw = ImageDraw.Draw(canvas)

f_fr = F_ANTON(218)
f_ar = F_BOLD(168)
for i, (fr, ar_txt, icon_fn) in enumerate(SERVICES):
    yt = cards_y[i]
    yc = yt + card_h / 2
    draw.rounded_rectangle([margin, yt, margin + card_w, yt + card_h], radius=90, fill=(255, 255, 255, 242))
    # left navy accent bar
    draw.rounded_rectangle([margin, yt, margin + 64, yt + card_h], radius=30, fill=NAVY + (255,))
    # icon disc
    disc_r = 340
    disc_cx = margin + 200 + disc_r
    draw.ellipse([disc_cx - disc_r, yc - disc_r, disc_cx + disc_r, yc + disc_r], fill=NAVY + (255,))
    draw.ellipse([disc_cx - disc_r + 26, yc - disc_r + 26, disc_cx + disc_r - 26, yc + disc_r - 26],
                 outline=(255, 255, 255, 70), width=10)
    icon_fn(draw, disc_cx - 165, yc - 165, 330, WHITE + (255,))
    # texts
    tx = disc_cx + disc_r + 130
    draw.text((tx, yc - 175), fr, font=f_fr, fill=NAVY + (255,), anchor="lm")
    fr_w = draw.textlength(fr, font=f_fr)
    draw.line([(tx, yc + 8), (tx + min(fr_w, 1500), yc + 8)], fill=ORANGE + (255,), width=24)
    draw.text((tx, yc + 265), ar(ar_txt), font=f_ar, fill=GRAY + (255,), anchor="lm")

# ---------------- Footer ----------------
print("Footer...", flush=True)
draw.text((cx, 10430), ar("جودة  •  احترافية  •  ضمان"), font=F_BLACK(196), fill=WHITE + (255,), anchor="mm")
draw_spaced(draw, (cx, 10720), "QUALITÉ  •  PROFESSIONNALISME  •  GARANTIE",
            F_BOLD(96), LIGHT_BLUE, tracking=14)

# ---------------- Save ----------------
print("Saving...", flush=True)
final = canvas.convert("RGB")
print_path = os.path.join(OUT, "FBM-RollUp-100x200cm-150dpi.jpg")
final.save(print_path, "JPEG", quality=95, dpi=(150, 150))
pdf_path = os.path.join(OUT, "FBM-RollUp-100x200cm-150dpi.pdf")
final.save(pdf_path, "PDF", resolution=150.0)
prev = final.copy()
prev.thumbnail((590, 1182), Image.LANCZOS)
prev_path = os.path.join(OUT, "FBM-RollUp-preview.jpg")
prev.save(prev_path, "JPEG", quality=88)
print("OK:")
print(" ", print_path)
print(" ", pdf_path)
print(" ", prev_path)
