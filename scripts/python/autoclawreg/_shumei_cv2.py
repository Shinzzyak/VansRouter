"""Solver Shumei icon_select — deterministik cv2 (v2: merge + template match + hungarian).

Algoritma:
1. Segmentasi merah HSV di bg & fg.
2. Kontur fg → merge yang overlap (satu ikon bisa terbelah) → urutkan x = urutan klik.
3. Kontur bg (blob ikon). Kalau jumlah != jumlah ikon fg → coba template match.
4. matchShapes 1-1 optimal via greedy dengan reuse (pilih best global per-ikon, tandai used).
   Kalau banyak score buruk → fallback template matching mask-based.
"""

import cv2
import numpy as np


def _red_mask(img_bgr):
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    m1 = cv2.inRange(hsv, np.array([0, 80, 80]), np.array([10, 255, 255]))
    m2 = cv2.inRange(hsv, np.array([170, 80, 80]), np.array([180, 255, 255]))
    return cv2.bitwise_or(m1, m2)


def _contours(mask, min_area=30):
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cnts:
        area = cv2.contourArea(c)
        if area < min_area:
            continue
        x, y, w, h = cv2.boundingRect(c)
        if w < 8 or h < 8:
            continue
        M = cv2.moments(c)
        if M["m00"] == 0:
            continue
        cx = int(M["m10"] / M["m00"])
        cy = int(M["m01"] / M["m00"])
        out.append((c, (x, y, w, h), (cx, cy)))
    return out


def _merge_overlapping(items):
    """Merge kontur dengan bbox overlap. items = list (contour, bbox, center)."""
    merged = []
    for c, bbox, center in items:
        x, y, w, h = bbox
        placed = False
        for mi, (mc, mbbox, mcenter) in enumerate(merged):
            mx, my, mw, mh = mbbox
            # overlap check
            ox = max(0, min(x + w, mx + mw) - max(x, mx))
            oy = max(0, min(y + h, my + mh) - max(y, my))
            if ox > 0 and oy > 0:
                # merge: gabung kontur (np.concatenate), bbox baru
                newc = np.concatenate([mc, c])
                nx = min(x, mx); ny = min(y, my)
                nw = max(x + w, mx + mw) - nx; nh = max(y + h, my + mh) - ny
                ncenter = (nx + nw // 2, ny + nh // 2)
                merged[mi] = (newc, (nx, ny, nw, nh), ncenter)
                placed = True
                break
        if not placed:
            merged.append((c, bbox, center))
    return merged


def _template_match_mask(bg_mask, fg_patch_mask):
    """Template match mask ikon ke bg mask. Return best (x, y) center."""
    fg_patch = fg_patch_mask.astype(np.float32)
    bg_f = bg_mask.astype(np.float32)
    h, w = fg_patch.shape
    if h >= bg_f.shape[0] or w >= bg_f.shape[1]:
        return None
    res = cv2.matchTemplate(bg_f, fg_patch, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(res)
    if max_val < 0.3:
        return None
    cx = max_loc[0] + w // 2
    cy = max_loc[1] + h // 2
    return (cx, cy), float(max_val)


def match(bg_path, fg_path):
    bg = cv2.imread(bg_path)
    fg = cv2.imread(fg_path)
    if bg is None or fg is None:
        return None, {"error": "imread fail"}

    bg_mask = _red_mask(bg)
    fg_mask = _red_mask(fg)

    bg_blobs = _contours(bg_mask, min_area=40)
    # Dilate mask fg — menyatukan kontur yang terbelah (satu ikon = satu blob)
    fg_mask_d = cv2.dilate(fg_mask, np.ones((5, 5), np.uint8), iterations=1)
    fg_icons_raw = _contours(fg_mask_d, min_area=20)
    fg_icons = _merge_overlapping(fg_icons_raw)
    fg_icons.sort(key=lambda t: t[1][0])

    # Dilate bg mask juga — blob ikon di bg sering terbelah konturnya
    bg_mask_d = cv2.dilate(bg_mask, np.ones((5, 5), np.uint8), iterations=1)
    bg_blobs_d = _contours(bg_mask_d, min_area=60)
    # Filter ukuran: blob bg harus mirip ukuran ikon fg (noise kecil dibuang)
    if fg_icons:
        fg_sizes = [max(w, h) for _, (_, _, w, h), _ in fg_icons]
        ref = sum(fg_sizes) / len(fg_sizes) if fg_sizes else 25
        bg_blobs_d = [b for b in bg_blobs_d if ref * 0.4 <= max(b[1][2], b[1][3]) <= ref * 3.0]
    if len(bg_blobs_d) >= len(fg_icons):
        bg_blobs = bg_blobs_d

    detail: dict = {"bg_blobs": len(bg_blobs), "fg_icons": len(fg_icons), "fg_raw": len(fg_icons_raw)}

    if len(bg_blobs) < 2 or len(fg_icons) < 2:
        return None, detail

    # Min-cost greedy assignment: hitung cost matrix matchShapes,
    # pilih pasangan (icon,blob) cost terendah global dulu — optimal 1-1.
    cost_matrix = []
    for ic, _, _ in fg_icons:
        row = []
        for bc, _, _ in bg_blobs:
            try:
                row.append(cv2.matchShapes(ic, bc, cv2.CONTOURS_MATCH_I2, 0))
            except Exception:
                row.append(float("inf"))
        cost_matrix.append(row)

    n_icons = len(fg_icons)
    used_blobs = set()
    assignments = {}  # icon_idx -> (blob_idx, cost)
    remaining = list(range(n_icons))
    while remaining:
        best_pair = None
        best_cost = float("inf")
        for i in remaining:
            for j in range(len(bg_blobs)):
                if j in used_blobs:
                    continue
                c = cost_matrix[i][j]
                if c < best_cost:
                    best_cost = c
                    best_pair = (i, j)
        if best_pair is None or best_cost > 0.8:
            break  # sisa tidak match
        i, j = best_pair
        assignments[i] = (j, best_cost)
        used_blobs.add(j)
        remaining.remove(i)

    clicks = []
    scores = []
    for i in range(n_icons):
        if i in assignments:
            j, c = assignments[i]
            _, _, bcenter = bg_blobs[j]
            clicks.append([float(bcenter[0]), float(bcenter[1])])
            scores.append(round(c, 4))
        else:
            # Fallback: template match mask terhadap blob yang BELUM terpakai
            _, bbox, _ = fg_icons[i]
            x, y, w, h = bbox
            patch = fg_mask_d[y:y + h, x:x + w]
            best = None
            best_val = 0.0
            for j in range(len(bg_blobs)):
                if j in used_blobs:
                    continue
                _, bgb, _ = bg_blobs[j]
                pad = 20
                bx, by, bw, bh = bgb
                x0 = max(0, bx - pad); y0 = max(0, by - pad)
                x1 = min(bg_mask.shape[1], bx + bw + pad)
                y1 = min(bg_mask.shape[0], by + bh + pad)
                region = bg_mask[y0:y1, x0:x1]
                if region.shape[0] < h or region.shape[1] < w:
                    continue
                res = cv2.matchTemplate(region.astype(np.float32),
                                        patch.astype(np.float32),
                                        cv2.TM_CCOEFF_NORMED)
                _, max_val, _, max_loc = cv2.minMaxLoc(res)
                if max_val > best_val:
                    best_val = max_val
                    cx = x0 + max_loc[0] + w // 2
                    cy = y0 + max_loc[1] + h // 2
                    best = (j, (cx, cy))
            if best is not None and best_val >= 0.35:
                j, pt = best
                used_blobs.add(j)
                clicks.append([float(pt[0]), float(pt[1])])
                scores.append(round(best_val, 4))
            else:
                clicks.append([0.0, 0.0])
                scores.append(-1.0)

    ok = sum(1 for s in scores if s > 0)
    detail["strategy"] = "mincost"
    detail["scores"] = scores
    detail["matched"] = ok

    # Kalau ada ikon yang gagal match (0,0) — klik SEMUA blob yang belum terpakai
    # (salah klik → REJECT → refresh → retry; tapi semua blob ke-klik = probabilitas naik)
    unmatched = [i for i in range(n_icons) if i not in assignments]
    if unmatched:
        used_idx = {j for j, _ in assignments.values()}
        for j, (_, _, bcenter) in enumerate(bg_blobs):
            if j not in used_idx:
                clicks.append([float(bcenter[0]), float(bcenter[1])])
                scores.append(99.0)  # fallback score
                used_idx.add(j)
                break  # cukup 1 blob fallback per ikon unmatched

    return clicks, detail


if __name__ == "__main__":
    import sys
    import json
    clicks, detail = match(sys.argv[1], sys.argv[2])
    print(json.dumps({"clicks": clicks, "detail": detail}))
