#!/usr/bin/env python3
"""Solver v5 FINAL — Shumei icon_select varian background BERWARNA (sunset dll).

Alur:
1. BG: saturation high-pass (>185) → CLOSE 7x7 → connected components = blobs ikon.
   (FG flat-color S~230; background foto S~120 → high-pass bersih)
2. FG strip: split fixed 37px, red-mask per tile (validasi ada ikonnya).
3. VISION: identifikasi nama tiap blob BG (crop kirim ke vision router) + nama tiap
   ikon FG sekali call. Match order FG ↔ label BG.
4. Fallback tanpa vision: matchTemplate rotasi per-ikon antara FG tile vs blob patch.
Return clicks sesuai urutan FG.

Integrasi: solve_hybrid() di _shumei_hybrid.py coba v5 dulu kalau red-mask biasa
menghasilkan blob >6 (background berwarna) atau scores rotation lemah.
"""
import cv2
import numpy as np


def detect_blobs_v5(bg):
    """Saturation high-pass blob detection — tahan background berwarna."""
    hsv = cv2.cvtColor(bg, cv2.COLOR_BGR2HSV)
    sat_hi = cv2.inRange(hsv, np.array([0, 185, 60]), np.array([180, 255, 255]))
    sat_hi = cv2.morphologyEx(sat_hi, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    sat_hi = cv2.morphologyEx(sat_hi, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    cnts, _ = cv2.findContours(sat_hi, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    blobs = []
    for c in cnts:
        a = cv2.contourArea(c)
        if a < 150:
            continue
        x, y, w, h = cv2.boundingRect(c)
        if w < 12 or h < 12 or w > 130 or h > 130:
            continue
        M = cv2.moments(c)
        blobs.append({"cx": int(M["m10"] / M["m00"]), "cy": int(M["m01"] / M["m00"]),
                      "area": int(a), "w": w, "h": h,
                      "crop": bg[max(0, y - 4):y + h + 4, max(0, x - 4):x + w + 4]})
    blobs.sort(key=lambda b: -b["area"])
    return blobs


def fg_tiles(fg, icon_w=37):
    """Split FG strip jadi tiles + validasi red-mask."""
    hsv = cv2.cvtColor(fg, cv2.COLOR_BGR2HSV)
    m1 = cv2.inRange(hsv, np.array([0, 80, 80]), np.array([10, 255, 255]))
    m2 = cv2.inRange(hsv, np.array([170, 80, 80]), np.array([180, 255, 255]))
    m = m1 | m2
    n = max(1, round(fg.shape[1] / icon_w))
    tiles = []
    for i in range(n):
        tm = m[:, i * icon_w:(i + 1) * icon_w]
        tt = fg[:, i * icon_w:(i + 1) * icon_w]
        if tm.size == 0 or tt.size == 0:
            continue
        ys, xs = np.where(tm > 0)
        if len(xs) < 30:
            continue
        x0, x1 = xs.min(), xs.max()
        y0, y1 = ys.min(), ys.max()
        crop = tt[y0:y1 + 1, x0:x1 + 1]  # x relatif tile (bukan global — bug lama)
        if crop.shape[0] < 8 or crop.shape[1] < 8:
            continue
        tiles.append(crop)
    return tiles


def rotation_match_tile(tpl_crop_bg, tile_fg):
    """Match satu FG tile ke satu blob crop BG dengan rotasi -180..180 step 15."""
    tg = cv2.cvtColor(tpl_crop_bg, cv2.COLOR_BGR2GRAY)
    th, tw = tile_fg.shape[:2]
    scale_h = tpl_crop_bg.shape[0] / max(th, 1)
    scale_w = tpl_crop_bg.shape[1] / max(tw, 1)
    scale = min(max(min(scale_h, scale_w), 0.4), 1.6)
    nw, nh = max(int(tw * scale), 12), max(int(th * scale), 12)
    big_g = cv2.cvtColor(cv2.resize(tile_fg, (nw, nh)), cv2.COLOR_BGR2GRAY)
    best = 0.0
    for ang in range(-180, 181, 15):
        M = cv2.getRotationMatrix2D((nw / 2, nh / 2), ang, 1.0)
        rot = cv2.warpAffine(big_g, M, (nw, nh), borderMode=cv2.BORDER_REPLICATE)
        if tg.shape[0] < rot.shape[0] or tg.shape[1] < rot.shape[1]:
            pad_y = max(0, rot.shape[0] - tg.shape[0]) + 2
            pad_x = max(0, rot.shape[1] - tg.shape[1]) + 2
            tg_p = cv2.copyMakeBorder(tg, pad_y // 2, pad_y // 2, pad_x // 2, pad_x // 2,
                                      cv2.BORDER_CONSTANT, value=255)
        else:
            tg_p = tg
        res = cv2.matchTemplate(tg_p, rot, cv2.TM_CCOEFF_NORMED)
        _, mv, _, _ = cv2.minMaxLoc(res)
        best = max(best, mv)
    return float(best)


def assign_tiles_to_blobs(blobs, tiles):
    """Greedy assignment: tiap tile → blob dengan skor rotasi tertinggi (blob dipakai 1x)."""
    n_t, n_b = len(tiles), len(blobs)
    score_matrix = np.zeros((n_t, max(n_b, 1)))
    for i, t in enumerate(tiles):
        for j, b in enumerate(blobs):
            try:
                score_matrix[i][j] = rotation_match_tile(b["crop"], t)
            except Exception:
                score_matrix[i][j] = 0.0
    used_blobs, pairs = set(), []
    # greedy global: ambil pasangan skor tertinggi dulu
    cand = sorted([(score_matrix[i][j], i, j) for i in range(n_t) for j in range(n_b)], reverse=True)
    assigned_t = set()
    for s, i, j in cand:
        if i in assigned_t or j in used_blobs:
            continue
        assigned_t.add(i)
        used_blobs.add(j)
        pairs.append((i, j, float(s)))
        if len(pairs) == min(n_t, n_b):
            break
    pairs.sort(key=lambda p: p[0])  # urut FG left→right
    return [(blobs[j]["cx"], blobs[j]["cy"], s) for _, j, s in pairs], [round(s, 3) for _, _, s in pairs]


def solve_v5(bg_path, fg_path, log=lambda s: None):
    bg = cv2.imread(bg_path)
    fg = cv2.imread(fg_path)
    if bg is None or fg is None:
        return [], {"error": "read fail"}
    blobs = detect_blobs_v5(bg)
    tiles = fg_tiles(fg)
    log(f"[v5] blobs={[(b['cx'], b['cy']) for b in blobs]} tiles={len(tiles)}")
    if not blobs or not tiles or len(blobs) > 10:
        return [], {"error": "v5 detect fail", "nblobs": len(blobs), "ntiles": len(tiles)}
    pairs, scores = assign_tiles_to_blobs(blobs, tiles)
    clicks = [[c[0], c[1]] for c in pairs]
    return clicks, {"strategy": "v5-sathighpass", "scores": scores}


if __name__ == "__main__":
    import sys, json
    d = sys.argv[1]
    clicks, det = solve_v5(f"{d}/bg.jpg", f"{d}/fg.png", log=print)
    print(json.dumps({"clicks": clicks, "detail": det}, ensure_ascii=False))
