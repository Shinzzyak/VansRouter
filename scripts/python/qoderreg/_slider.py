"""Aliyun slider solver — pure JS gap detection + feedback-loop drag (no cv2).

Port of solve_slider_v2.py, unchanged logic, stripped of all cv2/numpy.
"""
import base64
import math
import random
import time


def _js_gap_detect():
    """JS: alpha-masked NCC + edge voting. Returns dict with targetX etc.

    Accepts optional bgB64/pzB64 (data URLs) passed as kwargs — when the
    captcha images are http(s) URLs, page-side fetch() can hit CORS and
    return garbage; caller downloads via playwright request (no CORS) and
    passes base64 here.
    """
    return r"""
    async (arg) => {
      const bgB64 = arg && arg.bg, pzB64 = arg && arg.pz;
      const bgImg = document.querySelector('#aliyunCaptcha-img');
      const puzzleImg = document.querySelector('#aliyunCaptcha-puzzle');
      const slider = document.querySelector('#aliyunCaptcha-sliding-slider');
      if (!bgImg || !puzzleImg || !slider) return {targetX: -1, error: 'missing'};

      async function getPixels(img, b64) {
        let url;
        if (b64) {
          url = 'data:image/png;base64,' + b64;
        } else {
          url = img.src;
        }
        const res = await fetch(url, {signal: AbortSignal.timeout(10000)});
        const blob = await res.blob();
        const tmpUrl = URL.createObjectURL(blob);
        const tmp = new Image();
        await new Promise((r, j) => { tmp.onload = r; tmp.onerror = j; tmp.src = tmpUrl; });
        const c = document.createElement('canvas');
        c.width = tmp.naturalWidth; c.height = tmp.naturalHeight;
        c.getContext('2d').drawImage(tmp, 0, 0);
        const id = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        URL.revokeObjectURL(tmpUrl);
        return {w: c.width, h: c.height, data: id.data};
      }

      const bg = await getPixels(bgImg, bgB64);
      const pz = await getPixels(puzzleImg, pzB64);

      // alpha bbox
      let pzMinX = pz.w, pzMaxX = 0, pzMinY = pz.h, pzMaxY = 0;
      for (let y = 0; y < pz.h; y++) for (let x = 0; x < pz.w; x++) {
        if (pz.data[(y*pz.w+x)*4+3] > 128) {
          if (x<pzMinX) pzMinX=x; if (x>pzMaxX) pzMaxX=x;
          if (y<pzMinY) pzMinY=y; if (y>pzMaxY) pzMaxY=y;
        }
      }
      const cropW = pzMaxX-pzMinX+1, cropH = pzMaxY-pzMinY+1;
      if (cropW < 10 || cropH < 10) return {targetX: -1, error: 'no-alpha'};
      const cropN = cropW*cropH;
      const pzCropGray = new Float64Array(cropN);
      const pzMask = new Uint8Array(cropN);
      let maskCount = 0;
      for (let cy=0; cy<cropH; cy++) for (let cx=0; cx<cropW; cx++) {
        const si = ((pzMinY+cy)*pz.w+(pzMinX+cx))*4, di = cy*cropW+cx;
        const a = pz.data[si+3];
        pzMask[di] = a>128?1:0; if (a>128) maskCount++;
        pzCropGray[di] = pz.data[si]*0.299+pz.data[si+1]*0.587+pz.data[si+2]*0.114;
      }
      if (maskCount < cropN*0.05) return {targetX: -1, error: 'sparse-mask'};
      const bgN = bg.w*bg.h;
      const bgGray = new Float64Array(bgN);
      for (let i=0;i<bgN;i++){const idx=i*4; bgGray[i]=bg.data[idx]*0.299+bg.data[idx+1]*0.587+bg.data[idx+2]*0.114;}

      function blur3x3(data,w,h){const out=new Float64Array(w*h);
        for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++)out[y*w+x]=(
          data[(y-1)*w+(x-1)]+2*data[(y-1)*w+x]+data[(y-1)*w+(x+1)]+
          2*data[y*w+(x-1)]+4*data[y*w+x]+2*data[y*w+(x+1)]+
          data[(y+1)*w+(x-1)]+2*data[(y+1)*w+x]+data[(y+1)*w+(x+1)])/16;
        return out;}
      const bgBlur = blur3x3(bgGray,bg.w,bg.h);
      const pzBlur = blur3x3(pzCropGray,cropW,cropH);

      function maskedNCC(srcData,srcW,srcH,tplData,tplW,tplH,mask,maskN,pzOffsetY){
        const scores=[];
        const scanMinY=Math.max(0,pzOffsetY-10), scanMaxY=Math.min(srcH-tplH,pzOffsetY+10);
        for(let ox=1;ox<=srcW-tplW-1;ox++){
          for(let oy=scanMinY;oy<=scanMaxY;oy++){
            let tplMean=0,srcMean=0;
            for(let i=0;i<maskN;i++){if(!mask[i])continue; const tx=i%tplW,ty=(i/tplW)|0;
              tplMean+=tplData[i]; srcMean+=srcData[(oy+ty)*srcW+(ox+tx)];}
            tplMean/=maskN; srcMean/=maskN;
            let tplVar=0,srcVar=0,crossVar=0;
            for(let i=0;i<maskN;i++){if(!mask[i])continue; const tx=i%tplW,ty=(i/tplW)|0;
              const td=tplData[i]-tplMean, sd=srcData[(oy+ty)*srcW+(ox+tx)]-srcMean;
              tplVar+=td*td; srcVar+=sd*sd; crossVar+=sd*td;}
            tplVar/=maskN; srcVar/=maskN;
            const tplStd=Math.sqrt(tplVar), srcStd=Math.sqrt(srcVar);
            if(tplStd<0.001||srcStd<0.001)continue;
            scores.push({x:ox,y:oy,score:crossVar/(maskN*srcStd*tplStd)});
          }
        }
        let bestX=-1,bestY=-1,bestScore=-2;
        for(const s of scores) if(s.score>bestScore){bestScore=s.score;bestX=s.x;bestY=s.y;}
        return {bestX,bestY,bestScore};
      }

      const ncc = maskedNCC(bgBlur,bg.w,bg.h,pzBlur,cropW,cropH,pzMask,maskCount,pzMinY);
      const bgRect = bgImg.getBoundingClientRect();
      const sliderRect = slider.getBoundingClientRect();
      const candidates=[];
      if (ncc.bestX>=5) candidates.push({x:ncc.bestX,score:ncc.bestScore,method:'gray-ncc'});
      // edge voting: a real gap has strong vertical edges in the bg image
      // near the NCC position; keep the strongest-edge candidate above threshold
      function edgeScoreAt(x) {
        let s = 0;
        const y0 = Math.max(0, pzMinY - 20), y1 = Math.min(bg.h - 1, pzMinY + cropH + 20);
        for (let y = y0; y <= y1; y += 2) {
          const i = y * bg.w + x;
          const gx = bgGray[i - 1] !== undefined ? bgGray[i - 1] : bgGray[i];
          const gx2 = bgGray[i + 1] !== undefined ? bgGray[i + 1] : bgGray[i];
          s += Math.abs(gx2 - gx);
        }
        return s;
      }
      const best = candidates[0];
      if (best) {
        const es = edgeScoreAt(best.x);
        // scan ±30px for a stronger-edge position (NCC can peak on texture noise)
        let bestX = best.x, bestEdge = es;
        for (let dx = -30; dx <= 30; dx += 2) {
          const xx = best.x + dx;
          if (xx < 5 || xx > bg.w - cropW - 1) continue;
          const e = edgeScoreAt(xx);
          if (e > bestEdge * 1.35 && e > 40) { bestEdge = e; bestX = xx; }
        }
        if (bestX !== best.x) {
          candidates.push({x: bestX, score: best.score * 0.98, method: 'edge-vote'});
        }
      }
      let finalX=-1, finalScore=0;
      const agreeThreshold=15;
      for(let i=0;i<candidates.length;i++) for(let j=i+1;j<candidates.length;j++){
        if(Math.abs(candidates[i].x-candidates[j].x)<agreeThreshold){
          const avgX=Math.round((candidates[i].x+candidates[j].x)/2);
          const avgScore=(candidates[i].score+candidates[j].score)/2;
          if(avgScore>finalScore){finalX=avgX;finalScore=avgScore;}
        }
      }
      if(finalX<0 && candidates.length){finalX=candidates[0].x;finalScore=candidates[0].score;}
      if(finalX<0) return {targetX:-1,error:'no-candidate',ncc:ncc.bestX,nccScore:ncc.bestScore};
      const scale = bgRect.width / bg.w;
      const pzOffsetX = pzMinX || 0;
      const targetPuzzleLeft = (finalX - pzOffsetX) * scale;
      const bodyRect = (document.querySelector('#aliyunCaptcha-sliding-body') || slider).getBoundingClientRect();
      return {targetX: finalX, score: finalScore, nccX: ncc.bestX, nccScore: ncc.bestScore,
              targetPuzzleLeft, scale, pzOffsetX, cropW, bgW: bg.w,
              sliderX: sliderRect.x, sliderY: sliderRect.y,
              sliderW: sliderRect.width, sliderH: sliderRect.height,
              bodyW: bodyRect.width};
    }
    """


def _cdp_drag(cdp, sx, sy, tx, steps=15):
    """CDP trusted drag with HUMAN-like trajectory (riset 2026-08-14):
    ease-in-out + micro-jitter + random timing (10-30ms, kadang 40-80ms pause).
    Aliyun FeiLin risk engine menolak drag mekanik (kecepatan konstan ~1000px/s)."""
    import math
    n = steps if steps >= 10 else max(10, steps * 2)
    total_ms = random.uniform(400, 900)  # 244px dalam 400-900ms = 270-600 px/s (range manusia)
    pts = []
    for i in range(1, n + 1):
        t = i / n
        # ease-in-out cubic (mulai pelan, tengah cepat, akhir pelan)
        ease = 0.5 - 0.5 * math.cos(math.pi * t) if t < 0.9 else 1 - (1 - t) ** 2.2
        x = sx + (tx - sx) * ease
        # micro-jitter 0-1.5px + drift y natural
        y = sy + math.sin(t * math.pi * 2.3) * 1.2 + (random.random() - 0.5) * 2.2
        pts.append((x, y))
    # overshoot-pullback 30% kasus (manusia)
    if random.random() < 0.35 and steps >= 10:
        overshoot = random.uniform(4, 10)
        x0, y0 = pts[-1]
        pts[-1] = (x0 + overshoot, y0)
        for k in range(3):
            pts.append((x0 + overshoot - overshoot * (k + 1) / 4, y0 + (random.random() - 0.5) * 2))
    for (x, y) in pts:
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseMoved", "x": x, "y": y,
            "button": "left", "buttons": 1,
        })
        dt = random.uniform(10, 30)
        if random.random() < 0.12:
            dt = random.uniform(40, 80)
        time.sleep(dt / 1000.0)


def solve_slider_v2(page, max_attempts=6, log=print):
    """Solve Aliyun slider on page. Returns True on success."""
    for attempt in range(1, max_attempts + 1):
        log(f"[slider] attempt {attempt}/{max_attempts}", flush=True)
        try:
            # refresh captcha on retry (stale after wrong position)
            if attempt > 1:
                try:
                    ref = page.locator("#aliyunCaptcha-btn-refresh")
                    if ref.count() > 0 and ref.first.is_visible(timeout=2000):
                        ref.first.click()
                        log("[slider] captcha refreshed", flush=True)
                        page.wait_for_timeout(1500)
                except Exception:
                    pass
            # expand if collapsed
            try:
                collapsed = page.evaluate(
                    "() => { const s = document.querySelector('#aliyunCaptcha-sliding-slider'); "
                    "return !s || s.getBoundingClientRect().width === 0; }")
                if collapsed:
                    left = page.locator('#aliyunCaptcha-captcha-left')
                    if left.is_visible(timeout=3000):
                        left.click()
                        page.wait_for_timeout(2500)
            except Exception:
                pass
            # wait images ready + settle (captcha may refresh after failed attempt)
            try:
                page.wait_for_function(
                    "() => { const img = document.querySelector('#aliyunCaptcha-img'); "
                    "const slider = document.querySelector('#aliyunCaptcha-sliding-slider'); "
                    "return img && img.complete && img.naturalWidth > 0 && slider && slider.getBoundingClientRect().width > 0; }",
                    timeout=15000)
            except Exception:
                pass
            page.wait_for_timeout(1200)
            # gap detect — download imgs via playwright request (no CORS) when http(s)
            bg_b64 = pz_b64 = None
            try:
                img_src = page.locator("#aliyunCaptcha-img").first.get_attribute("src") or ""
                pz_src = page.locator("#aliyunCaptcha-puzzle").first.get_attribute("src") or ""
                if img_src.startswith("http") or pz_src.startswith("http"):
                    def _dl(url):
                        resp = page.request.get(url, timeout=15000)
                        if resp.ok:
                            return base64.b64encode(resp.body()).decode()
                        return None
                    bg_b64 = _dl(img_src) if img_src.startswith("http") else None
                    pz_b64 = _dl(pz_src) if pz_src.startswith("http") else None
            except Exception:
                pass
            gap = page.evaluate(_js_gap_detect(), {"bg": bg_b64, "pz": pz_b64})
            # sanity: score must be decent; retry fresh detect if too low
            if gap.get("score", 0) < 0.82:
                log(f"[slider] gap score {gap.get('score', 0):.3f} low, re-detect", flush=True)
                page.wait_for_timeout(800)
                gap = page.evaluate(_js_gap_detect(), {"bg": bg_b64, "pz": pz_b64})
                if gap.get("score", 0) < 0.75:
                    # RE-qoder 2026-08-10: re-detect masih rendah → skip attempt (jangan drag target salah)
                    log(f"[slider] re-detect still low {gap.get('score', 0):.3f}, skip attempt", flush=True)
                    page.wait_for_timeout(2000)
                    continue
            if not gap or gap.get("targetX", -1) <= 5:
                log(f"[slider] gap detect fail: {gap}", flush=True)
                page.wait_for_timeout(2000)
                continue
            tpl = gap["targetPuzzleLeft"]
            # RE-qoder 2026-08-10: hapus +15px offset hardcode — v3 sukses TANPA offset;
            # kalau ada bias sistematis, nudge adaptif (±20) yang koreksi.
            log(f"[slider] gap X={gap['targetX']} score={gap['score']:.3f} → left={tpl:.1f}px", flush=True)
            # drag — CDP trusted drag (Input.dispatchMouseEvent + buttons:1 on every move)
            # page.mouse = untrusted → Aliyun F015. CDP = trusted → passes verify gate.
            sx = gap["sliderX"] + 10
            sy = gap["sliderY"] + gap["sliderH"] / 2
            # riset 2026-08-14: mapping 1:1 — puzzle & mouse share coordinate
            # space (track); factor 1.21 (track_w/est_max) lama = overshoot sistematis.
            mx = max(10, min(1270, sx + tpl))
            cdp = None
            try:
                cdp = page.context.new_cdp_session(page)
                cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": sx, "y": sy})
                page.wait_for_timeout(60 + random.randint(0, 60))
                cdp.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": sx, "y": sy, "button": "left", "buttons": 1, "clickCount": 1})
                page.wait_for_timeout(40 + random.randint(0, 30))
                _cdp_drag(cdp, sx, sy, mx, 15)
                page.wait_for_timeout(150 + random.randint(0, 100))
                # feedback correction — DYNAMIC gain (riset 2026-08-14):
                # ratio puzzle/mouse NONLINEAR (0.29-0.68x per attempt). Ukur ratio
                # aktual dari coarse drag pertama, pakai untuk koreksi — bukan 0.45.
                cur0 = page.evaluate(
                    "() => parseFloat(document.querySelector('#aliyunCaptcha-puzzle')?.style.left) || 0")
                mouse_delta = max(abs(mx - sx), 1)
                ratio = cur0 / mouse_delta if mouse_delta else 0
                if ratio < 0.05:
                    log("[slider] drag tidak nempel (ratio<0.05) — grab ulang", flush=True)
                    try:
                        cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": mx, "y": sy, "button": "left", "buttons": 0, "clickCount": 1})
                    except Exception:
                        pass
                    continue
                log(f"[slider] measured ratio={ratio:.3f} (mouse {mouse_delta}px -> puzzle {cur0:.1f}px)", flush=True)
                for _step in range(1, 61):
                    cur = page.evaluate(
                        "() => parseFloat(document.querySelector('#aliyunCaptcha-puzzle')?.style.left) || 0")
                    rem = tpl - cur
                    if abs(rem) <= 1.0:
                        break
                    delta = rem / max(ratio, 0.1)
                    delta = max(-60, min(60, delta))
                    mx = max(10, min(1270, mx + delta))
                    _cdp_drag(cdp, sx, sy, mx, 6)
                    page.wait_for_timeout(30 + random.randint(0, 30))
                cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": mx, "y": sy, "button": "left", "buttons": 0, "clickCount": 1})
            except Exception:
                # fallback: page.mouse (may fail with F015, but better than nothing)
                page.mouse.move(sx, sy)
                page.wait_for_timeout(60 + random.randint(0, 60))
                page.mouse.down()
                page.wait_for_timeout(40 + random.randint(0, 30))
                page.mouse.move(mx, sy + (random.random() - 0.5) * 2, steps=15)
                page.wait_for_timeout(150 + random.randint(0, 100))
                for _step in range(1, 21):
                    cur = page.evaluate(
                        "() => parseFloat(document.querySelector('#aliyunCaptcha-puzzle')?.style.left) || 0")
                    rem = tpl - cur
                    if abs(rem) <= 1.0:
                        break
                    delta = max(-40, min(40, rem * 0.45)) + (random.random() - 0.5) * 2
                    mx = max(10, min(1270, mx + delta))
                    page.mouse.move(mx, sy + (random.random() - 0.5) * 2, steps=6)
                    page.wait_for_timeout(30 + random.randint(0, 30))
                page.mouse.up()
            page.wait_for_timeout(1500)
            # debug: read puzzle left
            try:
                cur_left = page.evaluate(
                    "() => parseFloat(document.querySelector('#aliyunCaptcha-puzzle')?.style.left) || 0")
                log(f"[slider] after drag: left={cur_left:.1f} target={tpl:.1f}", flush=True)
            except Exception:
                pass
            page.wait_for_timeout(1000)
            # solved check
            solved = page.evaluate("""() => {
              const w = document.querySelector('#aliyunCaptcha-captcha-wrapper');
              const bodyTxt = document.body ? document.body.innerText.toLowerCase().slice(0,300) : '';
              if (bodyTxt.includes('verified') || bodyTxt.includes('success')) return true;
              if (!w || w.offsetParent === null) return true;
              const s = document.querySelector('#aliyunCaptcha-sliding-slider');
              const cb = document.querySelector('#aliyunCaptcha-captcha-body');
              if (s && (s.className.includes('success') || s.className.includes('pass'))) return true;
              if (cb && (cb.className.includes('success') || cb.className.includes('pass'))) return true;
              return false;
            }""")
            if solved:
                log("[slider] CAPTCHA solved!", flush=True)
                return True
            log("[slider] wrong position, nudge", flush=True)
            # Nudge strategy: puzzle stays put after wrong — re-grab handle, nudge ±3..12px
            # (skill: alibaba-umid-tmd-bypass — proven for AliyunCaptcha)
            if cdp is not None:
                for nudge_i, nudge in enumerate([5, -5, 10, -10, 14, -14, 3, -3, 18, -18, 20, -20]):
                    if nudge_i >= 8:
                        break  # cap at 8 nudges to bound runtime (RE-qoder: semua offset kecil dulu)
                    page.wait_for_timeout(600)
                    try:
                        nx = mx + nudge
                        cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": sx, "y": sy, "button": "left", "buttons": 1})
                        page.wait_for_timeout(120)
                        cdp.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": sx, "y": sy, "button": "left", "buttons": 1, "clickCount": 1})
                        page.wait_for_timeout(80)
                        _cdp_drag(cdp, sx, sy, nx, 8)
                        page.wait_for_timeout(200)
                        cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": nx, "y": sy, "button": "left", "buttons": 0, "clickCount": 1})
                    except Exception:
                        break
                    page.wait_for_timeout(1200)
                    solved = page.evaluate("""() => {
                      const w = document.querySelector('#aliyunCaptcha-captcha-wrapper');
                      const bodyTxt = document.body ? document.body.innerText.toLowerCase().slice(0,300) : '';
                      if (bodyTxt.includes('verified') || bodyTxt.includes('success')) return true;
                      if (!w || w.offsetParent === null) return true;
                      const s = document.querySelector('#aliyunCaptcha-sliding-slider');
                      const cb = document.querySelector('#aliyunCaptcha-captcha-body');
                      if (s && (s.className.includes('success') || s.className.includes('pass'))) return true;
                      if (cb && (cb.className.includes('success') || cb.className.includes('pass'))) return true;
                      return false;
                    }""")
                    if solved:
                        log("[slider] CAPTCHA solved! (nudge)", flush=True)
                        return True
            log("[slider] nudge exhausted, retry", flush=True)
            page.wait_for_timeout(2000)
        except Exception as e:
            log(f"[slider] attempt {attempt} exc: {e}", flush=True)
            page.wait_for_timeout(2000)
    log("[slider] CAPTCHA failed after all attempts", flush=True)
    return False
