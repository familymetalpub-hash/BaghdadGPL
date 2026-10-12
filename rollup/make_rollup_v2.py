# -*- coding: utf-8 -*-
"""
Roll Up FBM Automatisme V2 — 100cm x 200cm @ 150 DPI (5906 x 11811 px)
Style: reference diagonal strips, green/black/white. No logo (text wordmark only).
Minimal FR + AR text. No phone numbers.
"""
import os, math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance, ImageOps
import arabic_reshaper
from bidi.algorithm import get_display

BASE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(BASE, "fonts")
ASSETS = os.path.join(BASE, "assets", "v2")
OUT = os.path.join(BASE, "output")
os.makedirs(OUT, exist_ok=True)

W, H = 5906, 11811
GREEN = (16, 185, 105)
DARK_GREEN = (7, 74, 46)
INK = (8, 14, 13)
BADGE_BG = (5, 22, 14)
WHITE = (255, 255, 255)
LIGHT_GREEN = (170, 235, 195)

def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)

F_ANTON = lambda s: font("Anton-Regular.ttf", s)
F_BOLD = lambda s: font("IBMPlexSansArabic-Bold.ttf", s)
F_SEMI = lambda s: font("IBMPlexSansArabic-SemiBold.ttf", s)
F_MED = lambda s: font("IBMPlexSansArabic-Medium.ttf", s)

def ar(text):
    return get_display(arabic_reshaper.reshape(text))

def draw_spaced(draw, xy, text, fnt, fill, tracking=0, anchor="mm"):
    widths = [draw.textlength(ch, font=fnt) for ch in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x, y = xy
    if anchor == "mm":
        x -= total / 2
    for ch, wch in zip(text, widths):
        draw.text((x, y), ch, font=fnt, fill=fill, anchor="lm")
        x += wch + tracking
    return total

def rrect(cx, cy, w, h, ang_deg):
    a = math.radians(ang_deg)
    dx1, dy1 = math.cos(a) * w / 2, math.sin(a) * w / 2
    dx2, dy2 = -math.sin(a) * h / 2, math.cos(a) * h / 2
    return [(cx + dx1 + dx2, cy + dy1 + dy2), (cx + dx1 - dx2, cy + dy1 - dy2),
            (cx - dx1 - dx2, cy - dy1 - dy2), (cx - dx1 + dx2, cy - dy1 + dy2)]

# ---------------- Icons (white line style) ----------------
def ic_verin(dr, cx, cy, s, fg, bg):
    dr.rectangle([cx - s*.62, cy - s*.30, cx - s*.30, cy + s*.30], fill=fg)          # mount
    dr.rectangle([cx - s*.30, cy - s*.16, cx + s*.18, cy + s*.16], fill=fg)          # cylinder
    dr.rectangle([cx + s*.18, cy - s*.07, cx + s*.50, cy + s*.07], fill=fg)          # rod
    dr.rectangle([cx + s*.44, cy - s*.24, cx + s*.66, cy + s*.24], fill=fg)          # end mount
    dr.ellipse([cx - s*.50, cy - s*.06, cx - s*.38, cy + s*.06], fill=bg)
    dr.ellipse([cx + s*.50, cy - s*.06, cx + s*.58, cy + s*.06], fill=bg)

def ic_sliding(dr, cx, cy, s, fg, bg):
    dr.rectangle([cx - s*.60, cy - s*.42, cx + s*.60, cy + s*.12], outline=fg, width=int(s*.09))
    for i in range(-2, 3):
        x = cx + s*.20*i
        dr.line([(x, cy - s*.42), (x, cy + s*.12)], fill=fg, width=int(s*.06))
    ay = cy + s*.40
    dr.line([(cx - s*.55, ay), (cx + s*.40, ay)], fill=fg, width=int(s*.10))
    dr.polygon([(cx + s*.40, ay - s*.16), (cx + s*.62, ay), (cx + s*.40, ay + s*.16)], fill=fg)

def ic_barrier(dr, cx, cy, s, fg, bg):
    dr.rectangle([cx - s*.55, cy - s*.10, cx - s*.25, cy + s*.55], fill=fg)          # post
    px, py = cx - s*.40, cy - s*.10
    ang = -26
    a = math.radians(ang)
    L, T = s*1.25, s*.20
    ex, ey = px + math.cos(a)*L, py + math.sin(a)*L
    nx, ny = -math.sin(a)*T/2, math.cos(a)*T/2
    dr.polygon([(px+nx, py+ny), (ex+nx, ey+ny), (ex-nx, ey-ny), (px-nx, py-ny)], fill=fg)
    for t in (0.25, 0.5, 0.75):  # stripes
        sx, sy = px + math.cos(a)*L*t, py + math.sin(a)*L*t
        dr.polygon(rrect(sx, sy, s*.09, T*1.15, ang+90), fill=bg)
    dr.ellipse([px - s*.13, py - s*.13, px + s*.13, py + s*.13], fill=fg)

def ic_shutter(dr, cx, cy, s, fg, bg):
    dr.rectangle([cx - s*.45, cy - s*.55, cx + s*.45, cy + s*.55], outline=fg, width=int(s*.09))
    for i in range(1, 7):
        y = cy - s*.55 + s*1.10*i/7
        dr.line([(cx - s*.36, y), (cx + s*.36, y)], fill=fg, width=int(s*.05))
    dr.rectangle([cx - s*.40, cy + s*.38, cx + s*.40, cy + s*.52], fill=fg)

def ic_slats(dr, cx, cy, s, fg, bg):
    for i in range(3):
        y0 = cy - s*.40 + i*s*.36
        dr.polygon([(cx - s*.60, y0 + s*.10), (cx, y0 - s*.08),
                    (cx + s*.60, y0 + s*.10), (cx, y0 + s*.28)], fill=fg)

def ic_gear(dr, cx, cy, s, fg, bg):
    for k in range(8):
        dr.polygon(rrect(cx + math.cos(k*math.pi/4)*s*.40, cy + math.sin(k*math.pi/4)*s*.40,
                         s*.24, s*.24, k*45), fill=fg)
    dr.ellipse([cx - s*.34, cy - s*.34, cx + s*.34, cy + s*.34], outline=fg, width=int(s*.11))
    dr.ellipse([cx - s*.10, cy - s*.10, cx + s*.10, cy + s*.10], fill=fg)

def ic_wrench(dr, cx, cy, s, fg, bg):
    dr.polygon(rrect(cx - s*.08, cy + s*.12, s*.95, s*.22, 45), fill=fg)  # handle
    hx, hy = cx + s*.30, cy - s*.26  # head center
    dr.ellipse([hx - s*.27, hy - s*.27, hx + s*.27, hy + s*.27], fill=fg)
    dr.ellipse([hx - s*.13, hy - s*.13, hx + s*.13, hy + s*.13], fill=bg)
    dr.polygon(rrect(hx + s*.20, hy - s*.20, s*.34, s*.24, 45), fill=bg)  # open mouth
    tx, ty = cx - s*.40, cy + s*.44
    dr.ellipse([tx - s*.07, ty - s*.07, tx + s*.07, ty + s*.07], fill=bg)  # tail hole

def ic_shield(dr, cx, cy, s, fg, bg):
    pts = [(cx - s*.38, cy - s*.42), (cx + s*.38, cy - s*.42), (cx + s*.38, cy + s*.02),
           (cx, cy + s*.50), (cx - s*.38, cy + s*.02)]
    dr.line(pts + [pts[0]], fill=fg, width=int(s*.10), joint="curve")
    dr.line([(cx - s*.18, cy - s*.02), (cx - s*.02, cy + s*.14), (cx + s*.22, cy - s*.18)],
            fill=fg, width=int(s*.10), joint="curve")

# ---------------- Canvas ----------------
print("Canvas...", flush=True)
canvas = Image.new("RGBA", (W, H), WHITE + (255,))

# ---------------- Photo strips ----------------
STRIP_TOP, STRIP_BOT, N = 1850, 10150, 5
strip_h = (STRIP_BOT - STRIP_TOP) / N
S = 170  # boundary slant
GAP = 48  # white separator width

photos = ["verin-x4.png", "coulissant-x4.png", "barriere-x4.png", "rideau-x4.png", "fabrication-x4.png"]
FLIP = {"barriere-x4.png", "fabrication-x4.png"}  # keep subject clear of badge
print("Strips...", flush=True)
for i, ph in enumerate(photos):
    img = Image.open(os.path.join(ASSETS, ph)).convert("RGB")
    if ph in FLIP:
        img = ImageOps.mirror(img)
    img = ImageEnhance.Color(img).enhance(1.06)
    img = ImageEnhance.Contrast(img).enhance(1.04)
    tw = W + 900
    sc = tw / img.width
    img = img.resize((tw, int(img.height * sc) + 1), Image.LANCZOS)
    img = img.filter(ImageFilter.UnsharpMask(radius=5, percent=55, threshold=2))
    y0, y1 = STRIP_TOP + i * strip_h, STRIP_TOP + (i + 1) * strip_h
    # cover crop vertical center
    need_h = int(strip_h + 2 * S + 120)
    yy = max(0, (img.height - need_h) // 2)
    crop = img.crop((0, yy, tw, yy + need_h))
    crop = crop.resize((tw, need_h), Image.LANCZOS)
    # paste with slanted mask
    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    md.polygon([(0, y0 + S + GAP/2), (W, y0 - S + GAP/2), (W, y1 - S - GAP/2), (0, y1 + S - GAP/2)], fill=255)
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    layer.paste(crop.resize((W, need_h)), ((W - W)//2, int(y0 - S - 60)))
    # NOTE: crop already W+900 wide; center it
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    layer.paste(crop, (-450, int(y0 - S - 60)))
    layer.putalpha(mask)
    canvas = Image.alpha_composite(canvas, layer)

draw = ImageDraw.Draw(canvas)
# white separators along boundaries
for k in range(N + 1):
    y = STRIP_TOP + k * strip_h
    draw.polygon([(0, y + S - GAP/2), (W, y - S - GAP/2), (W, y - S + GAP/2), (0, y + S + GAP/2)], fill=WHITE + (255,))

# ---------------- Header ----------------
print("Header...", flush=True)
cx = W / 2
# green swooshes top-left
draw.polygon([(0, 0), (1050, 0), (420, 640), (0, 640)], fill=DARK_GREEN + (255,))
draw.polygon([(0, 0), (700, 0), (200, 500), (0, 500)], fill=GREEN + (255,))
draw.polygon([(0, 700), (300, 700), (0, 1000)], fill=GREEN + (255,))
# dark/green top-right
draw.polygon([(W, 0), (W, 520), (W - 780, 0)], fill=INK + (255,))
draw.polygon([(W, 150), (W, 520), (W - 480, 150)], fill=GREEN + (255,))
# FBM tricolor (no logo)
f_fbm = F_ANTON(700)
letters = [("F", INK), ("B", GREEN), ("M", INK)]
widths = [draw.textlength(ch, font=f_fbm) for ch, _ in letters]
track = 26
total = sum(widths) + track * 2
x = cx - total / 2
for (ch, col), wch in zip(letters, widths):
    draw.text((x, 640), ch, font=f_fbm, fill=col + (255,), anchor="lm")
    x += wch + track
draw_spaced(draw, (cx, 1150), "AUTOMATISME", F_ANTON(168), INK, tracking=64)
# tagline mixed colors
f_tag = F_SEMI(102)
parts = [("PORTES AUTOMATIQUES", INK), ("   |   ", GREEN), ("INSTALLATION & MAINTENANCE", INK)]
tot = sum(draw.textlength(t, font=f_tag) for t, _ in parts)
x = cx - tot / 2
for t, col in parts:
    draw.text((x, 1360), t, font=f_tag, fill=col + (255,), anchor="lm")
    x += draw.textlength(t, font=f_tag)
# small Arabic line with green side rules
tag_ar = ar("أبواب أوتوماتيكية  —  تركيب وصيانة")
f_ar = F_BOLD(96)
taw = draw.textlength(tag_ar, font=f_ar)
draw.text((cx, 1545), tag_ar, font=f_ar, fill=DARK_GREEN + (255,), anchor="mm")
draw.line([(cx - taw/2 - 330, 1545), (cx - taw/2 - 60, 1545)], fill=GREEN + (255,), width=14)
draw.line([(cx + taw/2 + 60, 1545), (cx + taw/2 + 330, 1545)], fill=GREEN + (255,), width=14)
# green wedge overlapping strip 1 top-right (after strips, before badges)
draw.polygon([(W - 1080, 1730), (W + 60, 1490), (W + 60, 1860), (W - 1080, 2100)], fill=GREEN + (255,))

# ---------------- Badges ----------------
print("Badges...", flush=True)
BADGES = [
    ("right", ["VÉRIN"], "أبواب مفصلية", ic_verin),
    ("left", ["COULISSANT"], "أبواب منزلقة", ic_sliding),
    ("right", ["BARRIÈRE"], "حواجز أوتوماتيكية", ic_barrier),
    ("left", ["RIDEAU MÉTALLIQUE", "AUTO"], "ستائر معدنية", ic_shutter),
    ("right", ["FABRICATION", "LAME RIDEAU"], "تصنيع الشرائح", ic_slats),
]
BW, BH, DX = 1780, 800, 200
f_fr1, f_fr2, f_bar = F_ANTON(140), F_ANTON(124), F_BOLD(96)
for i, (side, fr_lines, ar_txt, icon_fn) in enumerate(BADGES):
    yc = STRIP_TOP + (i + 0.5) * strip_h
    yt, yb = yc - BH/2, yc + BH/2
    if side == "right":
        pts = [(W + 60, yt), (W - BW, yt), (W - BW - DX, yb), (W + 60 - DX, yb)]
        stripe = [(W - BW, yt), (W - BW + 52, yt), (W - BW - DX + 52, yb), (W - BW - DX, yb)]
        ccx = W - BW/2 - DX/2 - 40
    else:
        pts = [(-60, yt), (BW, yt), (BW + DX, yb), (-60 + DX, yb)]
        stripe = [(BW, yt), (BW - 52, yt), (BW + DX - 52, yb), (BW + DX, yb)]
        ccx = BW/2 + DX/2 + 40
    # shadow
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(px, py + 34) for px, py in pts], fill=(0, 0, 0, 110))
    sh = sh.filter(ImageFilter.GaussianBlur(30))
    canvas = Image.alpha_composite(canvas, sh)
    draw = ImageDraw.Draw(canvas)
    draw.polygon(pts, fill=BADGE_BG + (255,))
    draw.polygon(stripe, fill=GREEN + (255,))
    two = len(fr_lines) == 2
    icon_fn(draw, ccx, yc - (205 if not two else 225), 215, WHITE + (255,), BADGE_BG + (255,))
    f = f_fr2 if two else f_fr1
    if not two:
        draw.text((ccx, yc + 15), fr_lines[0], font=f, fill=WHITE + (255,), anchor="mm")
        ry = yc + 120
    else:
        draw.text((ccx, yc - 25), fr_lines[0], font=f, fill=WHITE + (255,), anchor="mm")
        draw.text((ccx, yc + 115), fr_lines[1], font=f, fill=WHITE + (255,), anchor="mm")
        ry = yc + 215
    draw.line([(ccx - 200, ry), (ccx + 200, ry)], fill=GREEN + (255,), width=16)
    draw.text((ccx, ry + 135), ar(ar_txt), font=f_bar, fill=LIGHT_GREEN + (255,), anchor="mm")

# ---------------- Footer ----------------
print("Footer...", flush=True)
def edge_y(x):
    t = 2 * x / W - 1
    return 10160 + 175 * (1 - t * t)
xs = list(range(0, W + 1, 60))
edge = [(x, edge_y(x)) for x in xs]
# green curve line + dark fill below
draw.line(edge, fill=GREEN + (255,), width=30)
dark = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(dark).polygon(edge + [(W, H), (0, H)], fill=INK + (255,))
# shift dark down a bit so green line sits on top
dark2 = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(dark2).polygon([(x, y + 34) for x, y in edge] + [(W, H), (0, H)], fill=INK + (255,))
canvas = Image.alpha_composite(canvas, dark2)
draw = ImageDraw.Draw(canvas)
# thin light swoosh under
draw.line([(x, edge_y(x) + 120) for x in xs], fill=(255, 255, 255, 60), width=10)
draw.rectangle([0, H - 620, W, H], fill=(3, 10, 8, 255))  # hidden base zone
# footer content
cols = [(W * 0.20, "INSTALLATION", "تركيب", ic_gear),
        (W * 0.50, "MAINTENANCE", "صيانة", ic_wrench),
        (W * 0.80, "FIABILITÉ", "موثوقية", ic_shield)]
f_ffr, f_far = F_ANTON(118), F_BOLD(88)
for ccx, fr, artxt, ic in cols:
    ic(draw, ccx, 10620, 200, WHITE + (255,), INK + (255,))
    draw.text((ccx, 10830), fr, font=f_ffr, fill=WHITE + (255,), anchor="mm")
    draw.text((ccx, 10990), ar(artxt), font=f_far, fill=LIGHT_GREEN + (255,), anchor="mm")
for dx in (W * 0.35, W * 0.65):
    draw.line([(dx, 10460), (dx, 11040)], fill=GREEN + (255,), width=14)

# ---------------- Save ----------------
print("Saving...", flush=True)
final = canvas.convert("RGB")
jp = os.path.join(OUT, "FBM-RollUp-V2-100x200cm-150dpi.jpg")
final.save(jp, "JPEG", quality=95, dpi=(150, 150))
fp = os.path.join(OUT, "FBM-RollUp-V2-100x200cm-150dpi.pdf")
final.save(fp, "PDF", resolution=150.0)
prev = final.copy()
prev.thumbnail((590, 1182), Image.LANCZOS)
pp = os.path.join(OUT, "FBM-RollUp-V2-preview.jpg")
prev.save(pp, "JPEG", quality=88)
print("OK:", jp, fp, pp, sep="\n  ")
