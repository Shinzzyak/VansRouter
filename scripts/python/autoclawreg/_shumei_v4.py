#!/usr/bin/env python3
"""Solver v4 untuk captcha Shumei varian background BERWARNA (sunset/orange):
red-mask global gagal (langit ikut merah). Solusi: FG icons = anchor warna EXAK.
1. Ekstrak warna merah EKSAK dari tiap ikon FG (median hue/sat/val per ikon strip).
2. BG: cari pixel yang MATCH eksak ke warna FG (toleransi ketat) — langit sunset punya
   distribusi beda (gradien), ikon flat-color → match ketat hanya kena ikon.
3. Connected components di matched mask → blob ikon BG.
4. Untuk tiap FG icon, matchTemplate patch BG sekitar blob terbaik.
"""
import cv2
import numpy as np


def fg_icon_colors(fg):
    """Ekstrak warna dominan tiap ikon FG (split fixed 37px)."""
    hsv = cv2.cvtColor(fg, cv2.COLOR_BGR2HSV)
    n = max(1, round(fg.shape[1] / 37))
    out = []
    for i in range(n):
        tile = hsv[:, i * 37:(i + 1) * 37]
        m1 = cv2.inRange(tile, np.array([0, 80, 80]), np.array([10, 255, 255]))
        m2 = cv2.inRange(tile, np.array([170, 80, 80]), np.array([180, 255, 255]))
        m = m1 | m2
        ys, xs = np.where(m > 0)
        if len(xs) < 30:
            out.append(None)
            continue
        h_med = np.median(tile[:, :, 0][m > 0])
        s_med = np.median(tile[:, :, 1][m > 0])
        v_med = np.median(tile[:, :, 2][m > 0])
        # bbox dalam tile
        x0, x1 = xs.min(), xs.max()
        y0, y1 = ys.min(), ys.max()
        out.append({"h": h_med, "s": s_med, "v": v_med,
                    "tpl": fg[y0:y1 + 1, i * 37 + x0:i * 37 + x1 + 1]})
    return out


def solve_v4(bg_path, fg_path, log=print):
    bg = cv2.imread(bg_path)
    fg = cv2.imread(fg_path)
    if bg is None or fg is None:
        return [], {"error": "read fail"}
    icons = fg_icon_colors(fg)
    log(f"[v4] fg icons valid: {sum(1 for i in icons if i)}/{len(icons)}")
    if not any(icons):
        return [], {"error": "no fg icons"}

    bg_hsv = cv2.cvtColor(bg, cv2.COLOR_BGR2HSV)
    H, W = bg.shape[:2]
    combined_mask = np.zeros((H, W), np.uint8)

    # VARIAN BARU: background berwarna (sunset) — red-mask global gagal karena
    # langit ikut merah. FG icons punya saturation sangat tinggi (flat color ~230),
    # background gradien lebih rendah (~120). Pakai SATURATION HIGH-PASS saja.
    sat_hi = cv2.inRange(bg_hsv, np.array([0, 185, 60]), np.array([180, 255, 255]))
    combined_mask |= sat_hi

    # bersihkan noise
    combined_mask = cv2.morphologyEx(combined_mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cnts, _ = cv2.findContours(combined_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    blobs = []
    for c in cnts:
        area = cv2.contourArea(c)
        if area < 150:
            continue
        x, y, w, h = cv2.boundingRect(c)
        if w < 12 or h < 12 or w > 130 or h > 130:
            continue
        M = cv2.moments(c)
        cx, cy = M["m10"] / M["m00"], M["m01"] / M["m00"]
        blobs.append({"cx": float(cx), "cy": float(cy), "x": x, "y": y, "w": w, "h": h, "area": float(area)})
    blobs.sort(key=lambda b: b["area"], reverse=True)
    log(f"[v4] blobs: {[(int(b['cx']), int(b['cy']), int(b['area'])) for b in blobs]}")

    clicks = []
    scores = []
    bg_gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    for idx, ic in enumerate(icons):
        if ic is None:
            continue
        tpl = ic["tpl"]
        th, tw = tpl.shape[:2]
        scale = 75 / max(th, tw)
        big = cv2.resize(tpl, (max(int(tw * scale), 20), max(int(th * scale), 20)))
        best = (0.0, None)
        for b in blobs[:8]:
            pad = 18
            x0 = max(0, b["x"] - pad); y0 = max(0, b["y"] - pad)
            x1 = min(W, b["x"] + b["w"] + pad); y1 = min(H, b["y"] + b["h"] + pad)
            roi_g = cv2.cvtColor(bg[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
            bh, bw = big.shape[:2]
            if roi_g.shape[0] < bh or roi_g.shape[1] < bw:
                continue
            res = cv2.matchTemplate(roi_g, cv2.cvtColor(big, cv2.COLOR_BGR2GRAY), cv2.TM_CCOEFF_NORMED)
            _, mv, _, ml = cv2.minMaxLoc(res)
            if mv > best[0]:
                best = (mv, (x0 + ml[0] + bw // 2, y0 + ml[1] + bh // 2))
        if best[1] and best[0] >= 0.30:
            clicks.append([best[1][0], best[1][1]])
            scores.append(round(float(best[0]), 3))
        else:
            clicks.append([int(blobs[len(clicks) % len(blobs)]["cx"]), int(blobs[len(clicks) % len(blobs)]["cy"])]) if blobs else None
            scores.append(round(float(best[0]), 3))
    return clicks, {"strategy": "v4-exact-color", "scores": scores,
                    "blobs": [(int(b["cx"]), int(b["cy"])) for b in blobs]}


if __name__ == "__main__":
    import sys, json
    d = sys.argv[1] if len(sys.argv) > 1 else "/tmp/shumei-live-b9e9xheh"
    clicks, det = solve_v4(f"{d}/bg.jpg", f"{d}/fg.png")
    print(json.dumps({"clicks": clicks, "detail": det}, ensure_ascii=False))
