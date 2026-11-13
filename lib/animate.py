#!/usr/bin/env python3
"""
Procedural 2.5D cartoon animator. Renders ONE scene to an MP4 (or a single PNG with --frame T).

Not an AI model: characters are drawn from shaded shapes with a rig (walk/run cycle, blinking,
eyebrows, emotions, lip-sync from the voice audio), over parallax backgrounds with camera moves.
Needs only python3 + numpy + opencv + scipy + ffmpeg. Fully offline and free.

usage: animate.py spec.json out.mp4 | animate.py spec.json out.png --frame 2.0
"""
import sys, json, math, subprocess
import numpy as np
import cv2

AA = cv2.LINE_AA
SH = 3
M = 1 << SH


def rgb(h):
    h = h.lstrip('#')
    return (int(h[4:6], 16), int(h[2:4], 16), int(h[0:2], 16))  # BGR


def shade(c, f):
    return tuple(max(0, min(255, int(v * f))) for v in c)


def mixc(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def lerp(a, b, t):
    return a + (b - a) * t


def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


WHITE = (255, 255, 255)
DARK = (28, 22, 30)

# ------------------------------------------------------------------ renderer


class R:
    def __init__(self, W, H):
        self.W, self.H = W, H
        self.HH = 1000.0 * H / W  # world is 1000 units wide
        self.portrait = H > W
        self.yh = self.HH * (0.70 if self.portrait else 0.80)  # horizon / ground line
        self.yf = self.yh + 0.08 * self.HH  # where characters' feet stand
        self.S = self.HH * (0.06 if self.portrait else 0.095)  # character unit
        self.img = np.zeros((H, W, 3), np.uint8)
        self.groundcol = (60, 90, 60)
        self._sky = {}
        self.set_cam(500, self.HH / 2, 1.0)
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        d = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
        v = np.clip(255 - 62 * np.clip(d - 0.55, 0, None) ** 1.6 * 1.6, 150, 255).astype(np.uint8)
        self.vig = np.dstack([v, v, v])

    def set_cam(self, cx, cy, z):
        self.cx, self.cy, self.z = cx, cy, z
        self.f = z * self.W / 1000.0

    def X(self, x, p=1.0):
        return (x - (500 + (self.cx - 500) * p)) * self.f + self.W / 2

    def Y(self, y, p=1.0):
        return (y - (self.HH / 2 + (self.cy - self.HH / 2) * p)) * self.f + self.H / 2

    def pt(self, x, y, p=1.0):
        return (int(round(self.X(x, p) * M)), int(round(self.Y(y, p) * M)))

    def circle(self, x, y, r, c, p=1.0):
        cv2.circle(self.img, self.pt(x, y, p), max(1, int(round(r * self.f * M))), c, -1, AA, SH)

    def ell(self, x, y, rx, ry, c, ang=0, p=1.0, a0=0, a1=360, th=-1):
        cv2.ellipse(self.img, self.pt(x, y, p), (max(1, int(round(rx * self.f * M))), max(1, int(round(ry * self.f * M)))),
                    ang, a0, a1, c, th if th < 0 else max(1, int(round(th * self.f))), AA, SH)

    def poly(self, pts, c, p=1.0):
        cv2.fillPoly(self.img, [np.array([self.pt(x, y, p) for x, y in pts], np.int32)], c, AA, SH)

    def line(self, a, b, w, c, p=1.0):
        cv2.line(self.img, self.pt(a[0], a[1], p), self.pt(b[0], b[1], p), c, max(1, int(round(w * self.f))), AA, SH)

    def rect(self, x0, y0, x1, y1, c, p=1.0):
        self.poly([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], c, p)

    def glow(self, x, y, rad, c, alpha, p=1.0):
        # soft falloff: several translucent rings instead of one hard disc
        for k in range(1, 6):
            self._glow1(x, y, rad * (1.0 - (k - 1) * 0.17), c, alpha / 4.0, p)

    def _glow1(self, x, y, rad, c, alpha, p=1.0):
        cx, cy = self.X(x, p), self.Y(y, p)
        rp = rad * self.f
        x0, x1 = int(max(0, cx - rp)), int(min(self.W, cx + rp + 1))
        y0, y1 = int(max(0, cy - rp)), int(min(self.H, cy + rp + 1))
        if x1 <= x0 or y1 <= y0:
            return
        roi = self.img[y0:y1, x0:x1]
        ov = roi.copy()
        cv2.circle(ov, (int(round((cx - x0) * M)), int(round((cy - y0) * M))), int(round(rp * M)), c, -1, AA, SH)
        cv2.addWeighted(ov, alpha, roi, 1 - alpha, 0, roi)

    def sky(self, name, top, bot, rows_to):
        key = (name, top, bot)
        if key not in self._sky:
            a = np.zeros((self.H, self.W, 3), np.uint8)
            n = max(2, int(rows_to))
            g = np.linspace(0, 1, n)[:, None]
            col = (np.array(rgb(top))[None, :] * (1 - g) + np.array(rgb(bot))[None, :] * g).astype(np.uint8)
            a[:n] = col[:, None, :][: self.H]
            if n < self.H:
                a[n:] = col[-1]
            self._sky[key] = a
        return self._sky[key]


# --------------------------------------------------------------- backgrounds

SETTINGS = {
    'morning': dict(sky=('#ffcf8a', '#8ecae6'), sun=(760, .22, 80, '#fff6c8'), hills=('#8bc98b', '#66b06f'), village=True, trees=True, ground='#6fbf73', path='#d2b48c', clouds=True),
    'day': dict(sky=('#5fb3f0', '#cfeaff'), sun=(230, .18, 70, '#fffbe0'), hills=('#79c47f', '#58a865'), village=True, trees=True, ground='#6fbf73', path='#d2b48c', clouds=True),
    'sunset': dict(sky=('#ff7e5f', '#ffc78a'), sun=(520, .62, 110, '#ffe29a'), hills=('#9a5f7a', '#74476a'), village=True, trees=True, ground='#6e5a4e', path='#a38466', clouds=True, cloud='#ffd8b8'),
    'night_room': dict(sky=('#241c4a', '#43336f'), room=True, ground='#58392a'),
    'dawn': dict(sky=('#34476b', '#f7b58a'), sun=(520, .66, 90, '#ffd9a0'), hills=('#41627a', '#2f4a5f'), trees=True, ground='#4d7a5a', path='#9a8a70', stars=True, clouds=True, cloud='#c9a9b6'),
    'city': dict(sky=('#7ec8ff', '#e8f6ff'), sun=(820, .16, 60, '#fffbe0'), city=True, ground='#c9d1dc', path='#aab3c0', clouds=True),
    'card': dict(sky=('#3a1c71', '#d76d77'), ground=None, sparkles=True),
}


def draw_bg(r, name, t):
    st = SETTINGS[name]
    HH, yh = r.HH, r.yh
    top, bot = st['sky']
    r.img[:] = r.sky(name, top, bot, yh if st.get('ground') else r.H)
    r.groundcol = rgb(st['ground']) if st.get('ground') else (80, 50, 90)

    if st.get('stars'):
        for k in range(45):
            sx = (k * 137) % 1000 - 0
            sy = ((k * 59) % 100) / 100.0 * yh * 0.5
            b = 0.5 + 0.5 * math.sin(t * 2 + k)
            r.circle(sx, sy, 1.6 + b, mixc(rgb('#8890b0'), WHITE, b), 0.05)
    if st.get('sun'):
        sx, syf, rad, col = st['sun']
        sy = yh * syf
        c = rgb(col)
        r.glow(sx, sy, rad * 3.0, c, 0.16, 0.1)
        r.glow(sx, sy, rad * 1.9, c, 0.26, 0.1)
        r.circle(sx, sy, rad, c, 0.1)
    if st.get('clouds'):
        cc = rgb(st.get('cloud', '#ffffff'))
        for k in range(5):
            bx = (k * 330 + t * (5 + 3 * (k % 2))) % 1500 - 250
            by = yh * (0.10 + 0.09 * (k % 3)) + 20
            for dx, dy, rx, ry in ((0, 0, 70, 26), (-45, 8, 45, 20), (50, 10, 52, 20), (8, -16, 40, 26)):
                r.ell(bx + dx, by + dy, rx, ry, cc, p=0.2)
    if st.get('hills'):
        for i, col in enumerate(st['hills']):
            base = yh - (0.075 - 0.035 * i) * HH
            amp = 0.028 * HH
            pts = [(x, base - amp * (math.sin(x * 0.006 + i * 2) + 0.5 * math.sin(x * 0.013 + i))) for x in range(-500, 1600, 40)]
            pts += [(1600, yh + 8), (-500, yh + 8)]
            r.poly(pts, rgb(col), 0.35 + 0.2 * i)
    if st.get('city'):
        hs = max(0.9, HH / 700.0)
        for k in range(-8, 24):
            x = k * 88
            h = (90 + (k * 53) % 170) * hs
            col = rgb('#6b7a99') if k % 2 else rgb('#8593b1')
            r.rect(x, yh - h, x + 76, yh, col, 0.5)
            for j in range(int(h // 34)):
                for q in range(2):
                    if (k * 7 + j * 3 + q) % 3:
                        r.rect(x + 12 + q * 34, yh - h + 14 + j * 34, x + 28 + q * 34, yh - h + 28 + j * 34, rgb('#ffe9a3'), 0.5)
    if st.get('village'):
        for k in range(-1, 6):
            x = k * 330 + 60 + (k * 41) % 70
            r.rect(x, yh - 82, x + 135, yh, rgb('#c9a47c'), 0.8)
            r.poly([(x - 14, yh - 80), (x + 67, yh - 145), (x + 149, yh - 80)], rgb('#a0522d'), 0.8)
            r.rect(x + 52, yh - 52, x + 82, yh, rgb('#6b4423'), 0.8)
            r.rect(x + 100, yh - 60, x + 122, yh - 38, rgb('#fff0c8'), 0.8)
    if st.get('trees'):
        for k in range(-1, 9):
            x = k * 230 + 40 + (k * 67) % 60
            r.rect(x - 8, yh - 100, x + 8, yh, rgb('#7b4b2a'), 0.9)
            for dx, dy, rr in ((0, -125, 48), (-30, -98, 36), (32, -98, 36)):
                r.circle(x + dx, yh + dy, rr, rgb('#3f9b55'), 0.9)
                r.circle(x + dx - 8, yh + dy - 8, rr * 0.55, rgb('#57b86c'), 0.9)
    if st.get('room'):
        # back wall already filled; window with moon, floor, shelf
        wy1 = yh - 0.15 * HH
        wy0 = wy1 - 300
        r.rect(590, wy0 - 14, 880, wy1 + 14, rgb('#6b4a35'))
        r.rect(604, wy0, 866, wy1, rgb('#0f1a3d'))
        for k in range(14):
            r.circle(612 + (k * 47) % 250, wy0 + 12 + (k * 31) % 260, 1.8, mixc(rgb('#6f78a8'), WHITE, 0.5 + 0.5 * math.sin(t * 2 + k)))
        r.glow(735, wy0 + 95, 90, rgb('#fff1b8'), 0.2)
        r.circle(735, wy0 + 95, 38, rgb('#fff6d0'))
        r.circle(724, wy0 + 88, 38, rgb('#0f1a3d'))  # crescent
        r.rect(733, wy0, 737, wy1, rgb('#6b4a35'))
        r.rect(604, (wy0 + wy1) / 2 - 2, 866, (wy0 + wy1) / 2 + 2, rgb('#6b4a35'))
    if st.get('ground'):
        gc = rgb(st['ground'])
        r.rect(-600, yh, 1600, yh + HH, gc)
        r.rect(-600, yh, 1600, yh + 0.012 * HH, shade(gc, 1.12))
        if st.get('path'):
            r.rect(-600, yh + 0.03 * HH, 1600, yh + 0.17 * HH, rgb(st['path']))
    if st.get('sparkles'):
        r.glow(500, r.yf - 200, 520, rgb('#ff9ad5'), 0.14, 0.3)
        for k in range(46):
            sx = (k * 211) % 1000
            sy = (k * 97) % int(HH)
            b = 0.5 + 0.5 * math.sin(t * 3 + k * 1.7)
            r.circle(sx, sy, 2 + 5 * b, mixc(rgb('#9f86ff'), WHITE, b), 0.6)
        r.ell(500, r.yf + 22, 330, 36, rgb('#2a1450'))


def draw_grass_fg(r, name, t):
    st = SETTINGS[name]
    if not st.get('ground') or st.get('room') or st.get('city'):
        return
    gc = shade(rgb(st['ground']), 0.78)
    y = r.yf + 0.13 * r.HH
    for k in range(-6, 22):
        x = k * 70 + (k * 29) % 40
        sw = 6 * math.sin(t * 2 + k)
        r.poly([(x, y + 40), (x + 9, y + 40), (x + 4 + sw, y - 26 - (k % 3) * 8)], gc, 1.25)


# ---------------------------------------------------------------- characters

OUT = {
    'rahul': dict(skin='#e0a47c', hair='#1c1410', shirt='#e8453c', pants='#3b5b92', shoe='#3a2a22', style='boy', scale=0.9),
    'rahul_adult': dict(skin='#e0a47c', hair='#1c1410', shirt='#f4f4f4', pants='#2b2f3e', shoe='#111111', style='man', tie='#c0392b', badge=True, scale=1.08),
    'mom': dict(skin='#d99a72', hair='#2a1a12', shirt='#e0409a', pants='#e0409a', shoe='#6b4a3a', style='woman', saree=True, scale=1.04),
    'dad': dict(skin='#cf8f66', hair='#2a2a2a', shirt='#4c8c4a', pants='#d8d2c4', shoe='#5b4636', style='man', mustache=True, scale=1.06),
    'villager1': dict(skin='#e8b48c', hair='#3a2a1a', shirt='#f1c40f', pants='#6d4c41', shoe='#3a2a22', style='man', mustache=True, scale=1.05),
    'villager2': dict(skin='#c98a63', hair='#111111', shirt='#7e57c2', pants='#455a64', shoe='#222222', style='man', scale=1.0),
}


def draw_char(r, who, x, yf, S, t, act, emo, talk, face):
    o = OUT[who]
    s = S * o.get('scale', 1.0)
    skin, hair, shirt, pants, shoe = (rgb(o[k]) for k in ('skin', 'hair', 'shirt', 'pants', 'shoe'))
    moving = act in ('walk', 'run')
    ph = t * (10.0 if act == 'run' else 6.5)
    amp = 0.95 if act == 'run' else 0.55
    up = 0.0
    if moving:
        up = abs(math.sin(ph)) * (0.2 if act == 'run' else 0.1) * s
    elif act == 'cheer':
        up = abs(math.sin(t * 7.0)) * 0.55 * s
    elif act == 'laugh':
        up = abs(math.sin(t * 9.0)) * 0.14 * s
    else:
        up = (math.sin(t * 2.2) * 0.5 + 0.5) * 0.035 * s
    legL = 1.7 * s
    hipy = yf - legL - up
    shy = hipy - 1.95 * s

    r.ell(x, yf + 0.1 * s, 1.7 * s * max(0.5, 1 - up / (4 * s)), 0.34 * s, shade(r.groundcol, 0.68))

    # legs
    if act != 'study':
        for i in (0, 1):
            side = -1 if i == 0 else 1
            a = math.sin(ph + math.pi * i) * amp if moving else 0.0
            hx0 = x + side * 0.42 * s
            fx = hx0 + face * math.sin(a) * legL
            fy = hipy + math.cos(a) * legL
            if moving:
                fy -= max(0.0, math.sin(ph + math.pi * i + 1.2)) * (0.45 if act == 'run' else 0.18) * s
            r.line((hx0, hipy), (fx, fy), 0.66 * s, pants)
            r.ell(fx + face * 0.28 * s, fy + 0.04 * s, 0.56 * s, 0.26 * s, shoe)

    # torso
    tcx, tcy = x, hipy - 1.0 * s
    if o.get('saree'):
        r.poly([(x - 0.95 * s, tcy), (x + 0.95 * s, tcy), (x + 1.6 * s, yf - 0.1 * s - up), (x - 1.6 * s, yf - 0.1 * s - up)], shade(shirt, 0.82))
        r.poly([(x - 0.25 * s, shy), (x + 0.3 * s, shy), (x + 0.95 * s, yf - 0.15 * s - up), (x + 0.35 * s, yf - 0.15 * s - up)], shade(shirt, 1.18))
    r.ell(tcx, tcy, 0.98 * s, 1.3 * s, shade(shirt, 0.78))
    r.ell(tcx - 0.06 * s, tcy - 0.04 * s, 0.9 * s, 1.22 * s, shirt)
    r.ell(tcx - 0.3 * s, tcy - 0.4 * s, 0.38 * s, 0.6 * s, shade(shirt, 1.14))
    if o.get('tie'):
        r.poly([(x - 0.5 * s, shy + 0.05 * s), (x, shy + 0.55 * s), (x - 0.12 * s, shy - 0.05 * s)], WHITE)
        r.poly([(x + 0.5 * s, shy + 0.05 * s), (x, shy + 0.55 * s), (x + 0.12 * s, shy - 0.05 * s)], WHITE)
        r.poly([(x - 0.13 * s, shy + 0.3 * s), (x + 0.13 * s, shy + 0.3 * s), (x + 0.2 * s, shy + 1.5 * s), (x, shy + 1.75 * s), (x - 0.2 * s, shy + 1.5 * s)], rgb(o['tie']))
    if o.get('badge'):
        r.rect(x + 0.35 * s, shy + 0.8 * s, x + 0.78 * s, shy + 1.3 * s, WHITE)
        r.rect(x + 0.4 * s, shy + 0.85 * s, x + 0.73 * s, shy + 1.0 * s, rgb('#2d7be5'))

    # arms
    armL = 1.55 * s
    top_desk = hipy - 0.45 * s
    for i in (0, 1):
        side = -1 if i == 0 else 1
        sx, sy = x + side * 0.88 * s, shy + 0.12 * s
        if act == 'cheer':
            ang = math.pi - 0.55 + 0.2 * math.sin(t * 9 + i)
            hx, hy = sx + side * math.sin(ang) * armL, sy + math.cos(ang) * armL
        elif act == 'laugh':
            hx, hy = x + side * 0.5 * s, hipy - 0.85 * s
        elif act == 'study':
            if i == 1:
                hx, hy = x + 0.95 * s + 0.35 * s * math.sin(t * 3.2), top_desk - 0.04 * s
            else:
                hx, hy = x - 0.95 * s, top_desk - 0.04 * s
        else:
            ang = math.sin(ph + math.pi * (1 - i)) * amp * 0.9 if moving else 0.08 * math.sin(t * 2 + i)
            hx, hy = sx + face * math.sin(ang) * armL, sy + math.cos(ang) * armL
        r.line((sx, sy), (hx, hy), 0.5 * s, shirt)
        r.circle(sx, sy, 0.27 * s, shirt)
        r.circle(hx, hy, 0.29 * s, skin)

    # head
    hx, hy = x, shy - 1.0 * s
    if emo in ('sad', 'cry'):
        hy += 0.12 * s
    if act == 'study':
        hy += 0.22 * s
    fs = face * 0.16 * s
    cx = hx + fs * 0.3
    look = 1.0 if (act == 'study' or emo in ('sad', 'cry')) else 0.0
    if o['style'] == 'woman':
        r.ell(hx - face * 0.1 * s, hy + 0.5 * s, 1.08 * s, 1.3 * s, hair)
    r.circle(hx, hy - 0.05 * s, 1.04 * s, hair)
    if o['style'] == 'woman':
        r.circle(hx - face * 0.1 * s, hy - 1.15 * s, 0.42 * s, hair)
    for sd in (-1, 1):
        r.circle(hx + sd * 0.95 * s + fs * 0.4, hy + 0.12 * s, 0.22 * s, shade(skin, 0.9))
    fcx, fcy, fr = hx + fs * 0.25, hy + 0.08 * s, 0.95 * s
    r.circle(fcx, fcy, fr, shade(skin, 0.8))
    r.circle(fcx - 0.04 * s, fcy - 0.04 * s, fr * 0.94, skin)
    r.circle(fcx - 0.3 * s, fcy - 0.34 * s, fr * 0.42, shade(skin, 1.1))
    r.ell(fcx, hy - 0.42 * s, 1.0 * s, 0.62 * s, hair, a0=180, a1=360)
    if o['style'] != 'woman':
        r.poly([(fcx - 0.9 * s, hy - 0.3 * s), (fcx - 0.1 * s * face, hy - 0.62 * s), (fcx + 0.5 * s, hy - 0.35 * s), (fcx + 0.15 * s, hy - 0.12 * s)], hair)
    if emo in ('happy', 'joy', 'laugh'):
        for sd in (-1, 1):
            r.circle(cx + sd * 0.64 * s, hy + 0.34 * s, 0.2 * s, rgb('#f28b82'))
    if who == 'mom':
        r.circle(cx + face * 0.05 * s, hy - 0.42 * s, 0.07 * s, rgb('#c0392b'))

    blink = 0.12 if (t % 3.1) < 0.11 else 1.0
    closed = emo in ('laugh',)
    eye_ry = {'surprised': 0.36}.get(emo, 0.27) * blink
    browc = shade(hair, 0.7)
    for sd in (-1, 1):
        ex, ey = cx + sd * 0.4 * s + face * 0.05 * s, hy + 0.08 * s
        if closed or emo == 'joy':
            r.ell(ex, ey + 0.06 * s, 0.23 * s, 0.17 * s, DARK, a0=200, a1=340, th=0.085 * s)
        else:
            r.ell(ex, ey, 0.23 * s, eye_ry * s, WHITE)
            if eye_ry > 0.1:
                px, py = ex + face * 0.07 * s, ey + look * 0.09 * s
                r.circle(px, py, 0.135 * s, DARK)
                r.circle(px - 0.04 * s, py - 0.05 * s, 0.045 * s, WHITE)
        by = ey - 0.5 * s
        iy, oy = by, by
        if emo in ('happy', 'joy'):
            iy, oy = by - 0.05 * s, by - 0.12 * s
        elif emo in ('sad', 'cry'):
            iy, oy = by - 0.14 * s, by + 0.1 * s
        elif emo == 'determined':
            iy, oy = by + 0.1 * s, by - 0.08 * s
        elif emo == 'surprised':
            iy, oy = by - 0.2 * s, by - 0.2 * s
        r.line((ex - sd * 0.26 * s, iy), (ex + sd * 0.26 * s, oy), 0.11 * s, browc)
        if emo in ('cry', 'joy'):
            for k in range(2):
                q = (t * 1.1 + k * 0.5 + (0.2 if sd > 0 else 0)) % 1.0
                r.circle(ex + sd * 0.1 * s, ey + 0.28 * s + q * 0.95 * s, (0.075 + 0.03 * (1 - q)) * s, rgb('#8fd3ff'))

    mx, my = cx + face * 0.06 * s, hy + 0.55 * s
    if o.get('mustache'):
        r.ell(mx, my - 0.17 * s, 0.34 * s, 0.1 * s, shade(hair, 0.8))
    mo = max(0.0, min(1.0, talk))
    if emo == 'laugh':
        mo = 0.55 + 0.45 * abs(math.sin(t * 10))
    if mo > 0.1:
        r.ell(mx, my + 0.04 * s, (0.2 + 0.1 * mo) * s, (0.05 + 0.27 * mo) * s, rgb('#7a1f2b'))
        if mo > 0.45:
            r.ell(mx, my + 0.04 * s + 0.1 * mo * s, 0.14 * s, 0.07 * s, rgb('#e86a7a'))
    elif emo in ('sad', 'cry'):
        r.ell(mx, my + 0.24 * s, 0.24 * s, 0.16 * s, DARK, a0=205, a1=335, th=0.075 * s)
    elif emo == 'determined':
        r.line((mx - 0.2 * s, my + 0.05 * s), (mx + 0.2 * s, my + 0.05 * s), 0.08 * s, DARK)
    else:
        r.ell(mx, my - 0.06 * s, 0.28 * s, 0.2 * s, DARK, a0=20, a1=160, th=0.08 * s)


# --------------------------------------------------------------------- props


def prop_desk(r, a, S, t):
    o = OUT[a['who']]
    s = S * o.get('scale', 1.0)
    x = a['x'] if not isinstance(a['x'], list) else a['x'][0]
    yf = r.yf
    top = yf - 1.7 * s - 0.45 * s - 0.0
    r.rect(x - 3.3 * s, top, x + 3.3 * s, top + 0.38 * s, rgb('#a06a35'))
    r.rect(x - 3.1 * s, top + 0.38 * s, x + 3.1 * s, yf + 0.05 * s, rgb('#6f4520'))
    r.rect(x - 3.1 * s, top + 0.38 * s, x - 2.9 * s, yf + 0.05 * s, rgb('#5a3719'))
    r.rect(x - 1.5 * s, top - 0.2 * s, x - 0.15 * s, top, rgb('#f1e3c1'))
    r.line((x - 0.83 * s, top - 0.2 * s), (x - 0.83 * s, top), 0.04 * s, rgb('#a89a78'))
    lx = x + 2.3 * s
    r.glow(lx, top - 1.2 * s, 4.6 * s, rgb('#ffd27a'), 0.13)
    r.glow(lx, top - 1.2 * s, 3.0 * s, rgb('#ffd27a'), 0.17)
    r.glow(lx, top - 1.2 * s, 1.7 * s, rgb('#ffe3a0'), 0.22)
    r.ell(lx, top, 0.55 * s, 0.1 * s, rgb('#3b3b4a'))
    r.line((lx, top), (lx - 0.3 * s, top - 1.35 * s), 0.1 * s, rgb('#3b3b4a'))
    r.poly([(lx - 0.75 * s, top - 1.0 * s), (lx - 0.05 * s, top - 1.0 * s), (lx - 0.2 * s, top - 1.5 * s), (lx - 0.6 * s, top - 1.5 * s)], rgb('#f4b942'))
    flick = 0.9 + 0.1 * math.sin(t * 17)
    r.ell(lx - 0.4 * s, top - 1.0 * s, 0.36 * s, 0.09 * s, mixc(rgb('#fff2b8'), WHITE, flick - 0.5))


def prop_bubble_city(r, a, S, t):
    o = OUT[a['who']]
    s = S * o.get('scale', 1.0)
    x = a['x'] if not isinstance(a['x'], list) else a['x'][0]
    bx, by = x + 1.2 * s, r.yf - 8.6 * s
    R_ = 3.4 * s
    r.circle(x + 0.55 * s, r.yf - 6.7 * s, 0.3 * s, rgb('#fff8ec'))
    r.circle(x + 0.8 * s, r.yf - 7.4 * s, 0.5 * s, rgb('#fff8ec'))
    r.ell(bx, by, R_ * 1.15, R_, rgb('#fff8ec'))
    r.ell(bx, by, R_ * 1.05, R_ * 0.9, rgb('#cfe9ff'))
    g = by + R_ * 0.55
    for k, (dx, w, h, col) in enumerate(((-1.9, 0.8, 1.5, '#5c6bc0'), (-1.0, 0.9, 2.4, '#7986cb'), (0.0, 1.0, 3.1, '#3f51b5'), (1.1, 0.9, 2.1, '#7986cb'), (2.0, 0.8, 1.2, '#5c6bc0'))):
        r.rect(bx + dx * s - w * s / 2, g - h * s, bx + dx * s + w * s / 2, g, rgb(col))
        for j in range(int(h * 1.6)):
            if (j + k) % 2:
                r.rect(bx + dx * s - 0.2 * s, g - h * s + 0.2 * s + j * 0.6 * s, bx + dx * s + 0.2 * s, g - h * s + 0.42 * s + j * 0.6 * s, rgb('#ffe9a3'))
    b = 0.7 + 0.3 * math.sin(t * 4)
    pts = []
    for q in range(10):
        ang = -math.pi / 2 + q * math.pi / 5
        rad = (0.62 if q % 2 == 0 else 0.26) * s * (0.8 + 0.4 * b)
        pts.append((bx + 0.2 * s + math.cos(ang) * rad, by - R_ * 0.35 + math.sin(ang) * rad))
    r.poly(pts, rgb('#ffd54f'))


def prop_letter(r, a, S, t):
    o = OUT[a['who']]
    s = S * o.get('scale', 1.0)
    x = a['x'] if not isinstance(a['x'], list) else a['x'][0]
    cx, cy = x, r.yf - 7.3 * s + 0.25 * s * math.sin(t * 3)
    ang = 0.18 * math.sin(t * 2.4)
    w, h = 1.5 * s, 1.0 * s
    def rot(px, py):
        return (cx + px * math.cos(ang) - py * math.sin(ang), cy + px * math.sin(ang) + py * math.cos(ang))
    r.glow(cx, cy, 2.6 * s, rgb('#fff1a8'), 0.28)
    r.poly([rot(-w, -h), rot(w, -h), rot(w, h), rot(-w, h)], rgb('#f8f8f2'))
    for k in range(4):
        r.poly([rot(-w * 0.8, -h * 0.55 + k * 0.28 * s), rot(w * 0.8, -h * 0.55 + k * 0.28 * s), rot(w * 0.8, -h * 0.55 + k * 0.28 * s + 0.08 * s), rot(-w * 0.8, -h * 0.55 + k * 0.28 * s + 0.08 * s)], rgb('#b7bdc9'))
    sx, sy = rot(w * 0.55, h * 0.55)
    r.circle(sx, sy, 0.24 * s, rgb('#d4a017'))


def prop_confetti(r, t, HH):
    pal = [rgb(c) for c in ('#ff5252', '#ffd740', '#69f0ae', '#40c4ff', '#e040fb', '#ffffff')]
    for k in range(64):
        sp = 70 + (k * 37) % 110
        x0 = (k * 173) % 1000
        y = ((k * 91) % int(HH) + sp * t) % (HH + 120) - 60
        x = x0 + 26 * math.sin(t * 2.2 + k)
        a = t * 4 + k
        c, s_ = math.cos(a), math.sin(a)
        w, h = 7, 13
        r.poly([(x + px * c - py * s_, y + px * s_ + py * c) for px, py in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))], pal[k % len(pal)], 1.1)


# ----------------------------------------------------------------- scene


def load_env(path, dur, fps):
    n = int(round(dur * fps))
    env = None
    if path:
        try:
            from scipy.io import wavfile
            sr, d = wavfile.read(path)
            d = d.astype(np.float32)
            if d.ndim > 1:
                d = d.mean(axis=1)
            win = max(1, int(sr / fps))
            vals = [float(np.sqrt(np.mean(d[i * win:(i + 1) * win] ** 2))) if d[i * win:(i + 1) * win].size else 0.0 for i in range(n)]
            ref = np.percentile(vals, 92) if len(vals) else 0
            if ref > 50:  # real voice present
                v = np.clip(np.array(vals) / ref, 0, 1)
                v = np.convolve(v, [0.25, 0.5, 0.25], mode='same')
                env = lambda i: float(v[min(i, n - 1)])
        except Exception:
            env = None
    if env is None:  # no audio: neutral pseudo mouth movement
        env = lambda i: 0.5 + 0.5 * math.sin(i / fps * 13.0) * math.sin(i / fps * 4.1)
    return env


def render_frame(r, spec, t, i, env):
    dur = spec['duration']
    p = min(1.0, t / dur)
    e = smooth(p)
    cam = spec.get('cam', {})
    cx = lerp(*cam.get('cx', [500, 500]), e)
    cyf = lerp(*cam.get('cy', [0.56, 0.56] if r.portrait else [0.5, 0.5]), e)
    z = lerp(*cam.get('z', [1.0, 1.0]), e)
    r.set_cam(cx, r.HH * cyf, z)
    draw_bg(r, spec['setting'], t)
    actors = spec.get('actors', [])
    for a in actors:
        x = lerp(a['x'][0], a['x'][1], p) if isinstance(a['x'], list) else a['x']
        face = a.get('dir') or (1 if (not isinstance(a['x'], list) or a['x'][1] >= a['x'][0]) else -1)
        emo = a.get('emoTo') if (a.get('emoTo') and p > 0.6) else a.get('emo', 'neutral')
        talk = env(i) if a.get('talk') else 0.0
        draw_char(r, a['who'], x, r.yf, r.S, t, a.get('act', 'stand'), emo, talk, face)
    props = spec.get('props', [])
    if actors:
        if 'desk' in props:
            prop_desk(r, actors[0], r.S, t)
        if 'bubble_city' in props:
            prop_bubble_city(r, actors[0], r.S, t)
        if 'letter' in props:
            prop_letter(r, actors[0], r.S, t)
    draw_grass_fg(r, spec['setting'], t)
    if 'confetti' in props:
        prop_confetti(r, t, r.HH)
    cv2.multiply(r.img, r.vig, dst=r.img, scale=1 / 255.0)
    fi, fo = spec.get('fade_in', 0.2), spec.get('fade_out', 0.2)
    k = 1.0
    if fi and t < fi:
        k = min(k, t / fi)
    if fo and t > dur - fo:
        k = min(k, max(0.0, (dur - t) / fo))
    if k < 0.999:
        r.img[:] = (r.img.astype(np.float32) * k).astype(np.uint8)


def main():
    spec = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    W, H = int(spec['w']), int(spec['h'])
    fps = int(spec.get('fps', 30))
    dur = float(spec['duration'])
    r = R(W, H)
    if '--frame' in sys.argv:
        t = float(sys.argv[sys.argv.index('--frame') + 1])
        render_frame(r, spec, t, int(t * fps), lambda i: 0.8)
        cv2.imwrite(out, r.img)
        return
    n = int(round(dur * fps))
    env = load_env(spec.get('wav'), dur, fps)
    ff = subprocess.Popen(
        ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(fps), '-i', '-',
         '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-t', f'{dur:.3f}', out],
        stdin=subprocess.PIPE)
    try:
        for i in range(n):
            render_frame(r, spec, i / fps, i, env)
            ff.stdin.write(r.img.tobytes())
    finally:
        try:
            ff.stdin.close()
        except Exception:
            pass
    if ff.wait() != 0:
        sys.exit('ffmpeg encode failed')


if __name__ == '__main__':
    main()
