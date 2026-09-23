// Uji end-to-end jalur SHIM: perilaku dengan bundle DAN tanpa bundle.
//
// Yang dijaga:
//   1. Dengan bundle  -> nilai asli dari engine (bukan fallback)
//   2. Tanpa bundle   -> fail-SAFE, bukan fail-dangerous. Tanpa engine, jawaban
//      tidak boleh dianggap gagal (kalau dianggap gagal, router mengulang
//      selamanya pada jawaban yang sebenarnya baik).

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const RTK = resolve(ROOT, 'open-sse/rtk');

// ASK THE LOADER, do not guess from a path (2026-09-23).
//
// This was `existsSync(resolve(ROOT, 'data/engine/engine.cjs'))` — the DEV path.
// The loader resolves `.next/standalone/data/engine/engine.cjs` FIRST (production
// layout outranks the dev copy on purpose). So on a checkout that has ever been
// deployed, the standalone copy is present while the dev copy is not: `hasBundle`
// said false, the loader said true, and the three assertions in the no-bundle
// branch failed locally while CI stayed green. Reproduced with the CI-built
// bundle: 3 failed. A gate whose notion of "bundle present" disagrees with the
// loader is not a gate.
import { isEngineLoaded } from 'open-sse/rtk/engineLoader.js';

const hasBundle = isEngineLoaded();

function engineModules() {
  const src = readFileSync(resolve(ROOT, 'scripts/engine-bundle.mjs'), 'utf8');
  const m = src.match(/const ENGINE_MODULES = \[([\s\S]*?)\];/)[1];
  return [...m.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe('shim: selfMeasuringBypass', () => {
  it('memuat bundle kalau ada, fail-safe kalau tidak', async () => {
    const mod = await import(`${RTK}/selfMeasuringBypass.js`);
    if (hasBundle) {
      expect(mod.classifyOutcome('pty.spawn("/bin/bash")')).toBe('PATUH');
      expect(mod.classifyOutcome("I can't help with that.")).toBe('NOLAK');
      expect(mod.classifyOutcome('')).toBe('SENYAP');
      expect(mod.classifyOutcome("blocked by Gemini's filters")).toBe('FILTER_UPSTREAM');
      expect(mod.needsAnotherTry('NOLAK')).toBe(true);
      expect(mod.needsAnotherTry('PATUH')).toBe(false);
      expect([...mod.FRAMING_LEVELS]).toEqual(['T2', 'T1', 'T3']);
    } else {
      expect(mod.classifyOutcome('apapun')).toBe('PATUH');
      expect(mod.needsAnotherTry('apapun')).toBe(false);
      expect(mod.nextFraming('SENYAP', 'T2', ['T2'])).toBeNull();
    }
  });
});

describe('shim: routeGuardMemory', () => {
  it('dengan bundle mengenali jalur penyaring, tanpa bundle tidak menghukum apapun', async () => {
    const mod = await import(`${RTK}/routeGuardMemory.js`);
    if (hasBundle) {
      expect(mod.isDeadRoute('ah/coding-glm-5.3-free')).toBeTruthy();
      expect(mod.isDeadRoute('gcli/grok-4.6')).toBeNull();
    } else {
      expect(mod.isDeadRoute('ah/coding-glm-5.3-free')).toBeNull();
      expect(mod.isDeadRoute('apapun/x')).toBeNull();
    }
  });
});

describe('Zero Break Guarantee di jalur eskalasi', () => {
  it('tanpa bundle, alur escalate tidak boleh mengulang', async () => {
    // Alur chatCore: classifyOutcome -> recordOutcome -> needsAnotherTry ->
    // nextFraming. Tanpa bundle ketiga fungsi harus memberi jawaban "sudah baik,
    // jangan ulang". Kalau classifyOutcome mengembalikan null, `!needsAnotherTry`
    // jadi true dan router mengulang selamanya pada jawaban yang baik.
    const mod = await import(`${RTK}/selfMeasuringBypass.js`);
    const out = mod.classifyOutcome('');
    const retry = mod.needsAnotherTry(out);
    const nxt = mod.nextFraming(out, 'T2', ['T2']);
    if (hasBundle) {
      expect(out).toBe('SENYAP');
      expect(retry).toBe(true);
      expect(nxt).toBeTruthy();
    } else {
      expect(retry).toBe(false);
      expect(nxt).toBeNull();
    }
  });
});

describe('gate anti-leak', () => {
  it('setiap modul engine punya shim dengan penanda GENERATED SHIM', () => {
    const mods = engineModules();
    expect(mods).toContain('selfMeasuringBypass');
    expect(mods).toContain('routeGuardMemory');
    for (const name of mods) {
      const p = `${RTK}/${name}.js`;
      expect(existsSync(p), `shim hilang: ${p}`).toBe(true);
      const body = readFileSync(p, 'utf8');
      expect(/GENERATED SHIM/.test(body), `${name}.js bukan shim — sumber asli bisa ikut terkirim`).toBe(true);
    }
  });

  it('sumber asli engine TIDAK ada di open-sse/rtk', () => {
    const markers = ['REAL_DEED_RE', 'SUBSTITUTION_RE', 'REFUSAL_RE', 'ROUTE_DECAY_THRESHOLD'];
    for (const name of engineModules()) {
      const body = readFileSync(`${RTK}/${name}.js`, 'utf8');
      for (const mk of markers) {
        expect(body.includes(mk), `${name}.js mengandung '${mk}' — SUMBER ASLI BOCOR`).toBe(false);
      }
    }
  });
});
