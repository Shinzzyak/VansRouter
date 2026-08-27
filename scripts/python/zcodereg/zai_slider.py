"""Aliyun slider gap-detect + drag solver (NCC + feedback loop).

Adapted from qoder-docker solve_slider_v2.py — proven to solve the
Aliyun slider on chat.z.ai. Operates on a Playwright page object.
"""
import random
import time

_JS_GAP_DETECT = r"""
async () => {
  const bgImg = document.querySelector('#aliyunCaptcha-img');
  const puzzleImg = document.querySelector('#aliyunCaptcha-puzzle');
  const slider = document.querySelector('#aliyunCaptcha-sliding-slider');
  if (!bgImg || !puzzleImg || !slider) return {targetX: -1, error: 'missing'};

  async function getPixels(img) {
    const res = await fetch(img.src, {signal: AbortSignal.timeout(10000)});
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const tmp = new Image();
    await new Promise((r, j) => { tmp.onload = r; tmp.onerror = j; tmp.src = url; });
    const c = document.createElement('canvas');
    c.width = tmp.naturalWidth; c.height = tmp.naturalHeight;
    c.getContext('2d').drawImage(tmp, 0, 0);
    const id = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    return {w: c.width, h: c.height, data: id.data};
  }

  const bg = await getPixels(bgImg);
  const pz = await getPixels(puzzleImg);

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
  let finalX = ncc.bestX, finalScore = ncc.bestScore;
  if (finalX < 0) return {targetX:-1,error:'no-candidate'};
  const scale = bgRect.width / bg.w;
  const pzOffsetX = pzMinX || 0;
  const targetPuzzleLeft = (finalX - pzOffsetX) * scale;
  return {targetX: finalX, score: finalScore, nccX: ncc.bestX, nccScore: ncc.bestScore,
          targetPuzzleLeft, scale, pzOffsetX, cropW, bgW: bg.w,
          sliderX: sliderRect.x, sliderY: sliderRect.y,
          sliderW: sliderRect.width, sliderH: sliderRect.height};
}
"""


def solve_slider_v2(page, max_attempts=6):
    """Solve Aliyun slider on a Playwright page. Returns True on success."""
    for attempt in range(1, max_attempts + 1):
        print(f"    ▸ slider attempt {attempt}/{max_attempts}", flush=True)
        try:
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
            try:
                page.wait_for_function(
                    "() => { const img = document.querySelector('#aliyunCaptcha-img'); "
                    "const slider = document.querySelector('#aliyunCaptcha-sliding-slider'); "
                    "return img && img.complete && img.naturalWidth > 0 && slider && slider.getBoundingClientRect().width > 0; }",
                    timeout=15000)
            except Exception:
                pass
            page.wait_for_timeout(500)
            gap = page.evaluate(_JS_GAP_DETECT)
            if not gap or gap.get("targetX", -1) <= 5:
                print(f"    ✗ gap detect fail: {gap}", flush=True)
                page.wait_for_timeout(2000)
                continue
            tpl = gap["targetPuzzleLeft"]
            print(f"    gap X={gap['targetX']} score={gap.get('score',0):.3f} → left={tpl:.1f}px", flush=True)
            sx = gap["sliderX"] + 10
            sy = gap["sliderY"] + gap["sliderH"] / 2
            track_w = gap["sliderW"]
            est_max = gap.get("bgW", 300) * gap.get("scale", 1.0) - 52
            page.mouse.move(sx, sy)
            page.wait_for_timeout(60 + random.randint(0, 60))
            page.mouse.down()
            page.wait_for_timeout(30 + random.randint(0, 30))
            frac = max(0.0, min(1.0, tpl / max(est_max, 1)))
            mx = max(10, min(1270, sx + frac * track_w))
            page.mouse.move(mx, sy + (random.random() - 0.5) * 2, steps=10)
            page.wait_for_timeout(100)
            for _ in range(1, 61):
                cur = page.evaluate("() => parseFloat(document.querySelector('#aliyunCaptcha-puzzle')?.style.left) || 0")
                rem = tpl - cur
                if abs(rem) <= 2:
                    break
                adj = track_w / max(est_max, 1)
                delta = max(-60, min(60, rem * adj)) + (random.random() - 0.5) * 2
                mx = max(10, min(1270, mx + delta))
                page.mouse.move(mx, sy + (random.random() - 0.5) * 2, steps=5)
                page.wait_for_timeout(15 + random.randint(0, 15))
            page.wait_for_timeout(50 + random.randint(0, 100))
            page.mouse.up()
            page.wait_for_timeout(2500)
            solved = page.evaluate("""() => {
              const w = document.querySelector('#aliyunCaptcha-captcha-wrapper');
              if (!w || w.offsetParent === null) return true;
              const s = document.querySelector('#aliyunCaptcha-sliding-slider');
              const cb = document.querySelector('#aliyunCaptcha-captcha-body');
              if (s && (s.className.includes('success') || s.className.includes('pass'))) return true;
              if (cb && (cb.className.includes('success') || cb.className.includes('pass'))) return true;
              return false;
            }""")
            if solved:
                print("    ✅ CAPTCHA solved!", flush=True)
                return True
            print("    ✗ wrong position, retry", flush=True)
            page.wait_for_timeout(2000)
        except Exception as e:
            print(f"    ✗ attempt {attempt} exc: {str(e)[:100]}", flush=True)
            page.wait_for_timeout(2000)
    return False