#!/usr/bin/env python3
"""Solver Shumei icon_select v3 — HYBRID cv2-blob + vision-per-blob.

Alur:
1. cv2: deteksi blob merah di BG (koordinat presisi) + segmentasi ikon FG (urutan klik).
2. Vision per-blob: crop tiap blob BG → identifikasi nama ikon (house/suitcase/...).
3. Vision FG strip sekali → urutan ikon instruksi.
4. Match urutan FG ↔ label blob BG (fuzzy) → klik koordinat center blob.
5. Fallback: cv2 mincost (matchShapes) kalau vision gagal parse.

Keunggulan vs satu-shot vision: koordinat dari cv2 (presisi), bukan tebakan model.
"""
import base64
import json
import os
import re
import sys
import tempfile
import urllib.request

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from ._shumei_cv2 import match as cv2_match
except ImportError:
    from _shumei_cv2 import match as cv2_match

ROUTER = os.environ.get("SOLVER_ROUTER", "http://127.0.0.1:20128")
MODEL = os.environ.get("SOLVER_MODEL", "combo/smart-fallback")
TOKEN_FILE = os.environ.get("CLI_TOKEN_FILE", "/tmp/9r_cli_token")

CANON = ["house", "suitcase", "clothes rack", "shopping basket", "speech bubble",
         "checkbox", "person", "fish", "car", "tree", "star", "heart", "clock",
         "phone", "glasses", "picture", "dog", "cat", "bird", "flower", "cup",
         "book", "key", "lock"]

ALIASES = {
    "home": "house", "clothing rack": "clothes rack", "shopping cart": "shopping basket",
    "cart": "shopping basket", "man": "person", "human": "person", "image": "picture",
    "photo": "picture", "briefcase": "suitcase", "luggage": "suitcase", "bag": "suitcase",
    "bubble": "speech bubble", "check box": "checkbox", "checkmark": "checkbox",
    "basket": "shopping basket", "clock time": "clock", "watch": "clock",
}


def load_token():
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except Exception:
        return ""


def to_b64(path):
    with open(path, "rb") as f:
        data = f.read()
    mime = "image/png" if path.endswith(".png") else "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


def call_vision(img_b64, prompt, timeout=40):
    token = load_token()
    try:
        body = {
            "model": MODEL,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": img_b64}},
                ],
            }],
            "max_tokens": 300,
            "stream": False,
        }
        req = urllib.request.Request(
            f"{ROUTER}/v1/chat/completions",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "x-9r-cli-token": token},
        )
        resp = urllib.request.urlopen(req, timeout=timeout)
        d = json.loads(resp.read())
        msg = d["choices"][0]["message"]
        return msg.get("content") or msg.get("reasoning") or ""
    except Exception:
        return ""


def canon_label(raw):
    """Normalisasi jawaban bebas vision → salah satu CANON.
    Vision sering output reasoning panjang; ambil dari KALIMAT TERAKHIR saja
    (jawaban final model), bukan seluruh teks."""
    s = raw.lower().strip()
    if not s:
        return ""
    # Kalimat terakhir
    sentences = re.split(r"(?<=[.!?])\s+", s)
    last = sentences[-1] if sentences else s
    # Cari kata kunci di kalimat terakhir (panjang dulu → paling spesifik)
    best = None
    for c in sorted(CANON, key=len, reverse=True):
        if c in last:
            best = c
            break
    if best:
        return ALIASES.get(best, best)
    # Fallback: cari di seluruh teks, tapi pilih yang muncul paling akhir
    for c in sorted(CANON, key=len, reverse=True):
        if c in s:
            return ALIASES.get(c, c)
    for alias, target in ALIASES.items():
        if alias in s:
            return target
    return ""


def red_mask(img_bgr):
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    m1 = cv2.inRange(hsv, np.array([0, 80, 80]), np.array([10, 255, 255]))
    m2 = cv2.inRange(hsv, np.array([170, 80, 80]), np.array([180, 255, 255]))
    return cv2.bitwise_or(m1, m2)


def bg_blobs_detect(bg_path):
    """Deteksi blob ikon merah di BG — return list dict dengan center + bbox.
    Filter: ukuran wajar ikon (max ~110px), buang blob raksasa (footer/watermark)."""
    bg = cv2.imread(bg_path)
    mask = red_mask(bg)
    mask_d = cv2.dilate(mask, np.ones((5, 5), np.uint8), iterations=1)
    cnts, _ = cv2.findContours(mask_d, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    blobs = []
    for c in cnts:
        area = cv2.contourArea(c)
        if area < 60:
            continue
        x, y, w, h = cv2.boundingRect(c)
        if w < 10 or h < 10:
            continue
        # Buang blob raksasa (bukan ikon: footer, watermark, strip teks)
        if w > 180 or h > 120:
            continue
        # Rasio wajar ikon (bukan garis tipis/teks)
        if w > h * 4 or h > w * 4:
            continue
        M = cv2.moments(c)
        if M["m00"] == 0:
            continue
        cx = float(M["m10"] / M["m00"])
        cy = float(M["m01"] / M["m00"])
        blobs.append({"cx": cx, "cy": cy, "x": x, "y": y, "w": w, "h": h, "area": area})
    blobs.sort(key=lambda b: b["area"], reverse=True)
    return blobs[:8]


def fg_icons_segment(fg_path):
    """Segmentasi strip FG → list bbox urut kiri→kanan."""
    fg = cv2.imread(fg_path)
    mask = red_mask(fg)
    mask_d = cv2.dilate(mask, np.ones((5, 5), np.uint8), iterations=1)
    cnts, _ = cv2.findContours(mask_d, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    items = []
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        if w < 6 or h < 6:
            continue
        items.append({"x": x, "y": y, "w": w, "h": h})
    items.sort(key=lambda b: b["x"])
    return items


def rotate_image(template, angle):
    center = (template.shape[1] // 2, template.shape[0] // 2)
    M = cv2.getRotationMatrix2D(center, angle, 1.0)
    return cv2.warpAffine(template, M, (template.shape[1], template.shape[0]),
                          flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def _tpl_score(tpl, img_gray):
    res = cv2.matchTemplate(img_gray, tpl, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(res)
    return max_val, max_loc


def rotation_clicks(bg_path, fg_path, icon_w=37):
    """Strategi taisuii/OpenCV_IconSelect (⭐15): red-mask → FG strip split per
    ikon (fixed width) → resize 75 → rotasi -180..180 step 6° → matchTemplate.
    Deterministik ~1s, tanpa vision API. Return (clicks, scores)."""
    bg = cv2.imread(bg_path)
    fg = cv2.imread(fg_path)
    if bg is None or fg is None:
        return [], []
    bg_red = np.zeros_like(bg)
    m = red_mask(bg)
    bg_red[m > 0] = bg[m > 0]
    fg_red = np.zeros_like(fg)
    m2 = red_mask(fg)
    fg_red[m2 > 0] = fg[m2 > 0]
    bg_g = cv2.cvtColor(bg_red, cv2.COLOR_BGR2GRAY)
    n_icons = max(1, round(fg.shape[1] / icon_w))
    strip_h = min(35, fg.shape[0])
    clicks, scores = [], []
    from concurrent.futures import ThreadPoolExecutor
    def one(i):
        x0 = i * icon_w
        tpl = fg_red[0:strip_h, x0:x0 + icon_w]
        if tpl.size == 0 or not np.any(tpl):
            return (0.0, (0, 0))
        big = cv2.resize(tpl, (75, 75))
        big_g = cv2.cvtColor(big, cv2.COLOR_BGR2GRAY)
        best = (0.0, (0, 0))
        for angle in range(-180, 181, 6):
            s, loc = _tpl_score(rotate_image(big_g, angle), bg_g)
            if s > best[0]:
                best = (s, loc)
        # loc = top-left dari window 75px di bg → center
        cx = best[1][0] + 37
        cy = best[1][1] + 37
        return (best[0], (int(cx), int(cy)))
    with ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(one, range(n_icons)))
    for s, c in results:
        if s >= 0.45:
            clicks.append(list(c))
            scores.append(round(float(s), 3))
    return clicks, scores


def solve_hybrid(bg_path, fg_path, log=lambda s: None):
    # STRATEGI 1: rotation match (taisuii ⭐15) — deterministik, cepat, tanpa vision
    r_clicks, r_scores = rotation_clicks(bg_path, fg_path)
    if len(r_clicks) >= 2 and all(s >= 0.55 for s in r_scores):
        log(f"[hybrid] ROTATION MATCH: {len(r_clicks)} clicks scores={r_scores}")
        return r_clicks, {"strategy": "rotation", "scores": r_scores}
    log(f"[hybrid] rotation lemah (scores={r_scores}) → vision path")

    # STRATEGI 2: v5 sat-highpass blob detect (background BERWARNA — sunset dll).
    # Kalau bg adalah foto berwarna (langit ikut red-mask biasa), pakai v5.
    try:
        from autoclawreg._shumei_v5 import detect_blobs_v5 as _v5_blobs
        v5_blobs = _v5_blobs(cv2.imread(bg_path))
        import math
        # v5 hit: 2-10 blobs dengan area wajar (10px+)
        v5_good = [b for b in v5_blobs if b["area"] >= 150]
        bg_red_count = int(red_mask(cv2.imread(bg_path)).sum() / 255)
        frac_red = bg_red_count / (cv2.imread(bg_path).shape[0] * cv2.imread(bg_path).shape[1])
        # Background foto berwarna = red-mask span sangat luas / proporsi > 8%
        if frac_red > 0.08 or len(v5_good) > 6:
            log(f"[hybrid] v5 background berwarna terdeteksi (red={frac_red:.2%}, v5={len(v5_good)})")
            from autoclawreg._shumei_v5 import solve_v5
            v_clicks, v_detail = solve_v5(bg_path, fg_path, log=log)
            if v_clicks and len(v_clicks) >= 2:
                # v5 butuh penanda order — hybrid vision path tetap untuk LABEL,
                # tapi koordinat pakai v5 (blob center) kalau label match gagal.
                log(f"[hybrid] v5 clicks: {v_clicks}")
                # simpan di state untuk dipakai kalau vision path gagal
                return v_clicks, {"strategy": "v5", "scores": v_detail.get("scores", [])}
    except Exception as e:
        log(f"[hybrid] v5 skip: {e}")

    blobs = bg_blobs_detect(bg_path)
    fg_icons = fg_icons_segment(fg_path)
    log(f"[hybrid] bg blobs={len(blobs)} fg icons={len(fg_icons)}")
    if not blobs or not fg_icons:
        # rotation masih jadi pilihan terakhir walau lemah
        if r_clicks:
            return r_clicks, {"strategy": "rotation-weak", "scores": r_scores}
        return [], {"error": "no blobs"}

    # 1. Identifikasi tiap blob BG via vision (crop + pad)
    bg_img = cv2.imread(bg_path)
    tmpdir = tempfile.mkdtemp(prefix="shumei-hyb-")
    labeled = []
    for i, b in enumerate(blobs):
        pad = 4
        x0 = max(0, b["x"] - pad); y0 = max(0, b["y"] - pad)
        x1 = min(bg_img.shape[1], b["x"] + b["w"] + pad)
        y1 = min(bg_img.shape[0], b["y"] + b["h"] + pad)
        crop_path = f"{tmpdir}/blob_{i}.png"
        cv2.imwrite(crop_path, bg_img[y0:y1, x0:x1])
        raw = call_vision(to_b64(crop_path),
                          "Red captcha icon. Answer with ONLY the icon name, one word or two words max. "
                          "Options: house, suitcase, clothes rack, shopping basket, speech bubble, "
                          "checkbox, person, fish, car, tree, star, heart, clock, phone, glasses, "
                          "picture, dog, cat, bird, flower, cup, book, key, lock.")
        label = canon_label(raw)
        log(f"[hybrid] blob{i} ({b['cx']:.0f},{b['cy']:.0f}) -> '{label}'")
        labeled.append({"label": label, **b})

    # 2. Urutan FG via vision strip penuh
    fg_order_raw = call_vision(to_b64(fg_path),
                               "Captcha instruction strip with RED icons left to right. "
                               "Answer ONLY a comma-separated list of icon names in order. "
                               "Options: house, suitcase, clothes rack, shopping basket, speech bubble, "
                               "checkbox, person, fish, car, tree, star, heart, clock, phone, glasses, "
                               "picture, dog, cat, bird, flower, cup, book, key, lock.")
    fg_labels = [canon_label(x) for x in fg_order_raw.replace("\n", ",").split(",") if canon_label(x)]
    log(f"[hybrid] fg order={fg_labels}")

    # 3. Match urutan FG → blob BG (greedy 1-1)
    used = set()
    clicks = []
    matched = 0
    for fl in fg_labels:
        hit = next((b for b in labeled if b["label"] and id(b) not in used and b["label"] == fl), None)
        if hit is None:
            continue
        used.add(id(hit))
        clicks.append([hit["cx"], hit["cy"]])
        matched += 1
    log(f"[hybrid] matched {matched}/{len(fg_labels)}")

    detail = {"strategy": "hybrid-vision", "matched": matched,
              "labels": [(b['cx'], b['cy'], b['label']) for b in labeled], "fg": fg_labels}

    # 4. Kalau match kurang dari jumlah ikon FG → fallback cv2 mincost
    if matched < len(fg_icons) or len(clicks) < 2:
        log("[hybrid] fallback cv2 mincost")
        c2_clicks, c2_detail = cv2_match(bg_path, fg_path)
        if c2_clicks and len(c2_clicks) >= 2:
            ok_c2 = sum(1 for s in c2_detail.get("scores", []) if isinstance(s, (int, float)) and 0 < s < 90)
            if ok_c2 > matched:
                detail["strategy"] = "fallback-cv2"
                detail["cv2_detail"] = c2_detail
                return c2_clicks[:len(fg_icons)], detail

    return clicks, detail


def match(bg_path, fg_path):
    clicks, detail = solve_hybrid(bg_path, fg_path)
    return clicks, detail


if __name__ == "__main__":
    res = match(sys.argv[1], sys.argv[2])
    print(json.dumps({"clicks": res[0], "detail": res[1]}, ensure_ascii=False))
