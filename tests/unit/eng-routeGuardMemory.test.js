// Uji routeGuardMemory — memori jalur penyaring yang BELAJAR SENDIRI.
//
// Aturan yang dijaga uji ini: daftar jalur busuk tidak boleh jadi tabel statis.
// Kalau sebuah jalur mulai bekerja (PATUH), catatan busuknya harus hilang sendiri.
// Kalau tidak, hari di mana Avres memperbaiki jalur `ah`, router akan tetap
// membuang model di jalur itu selamanya.

import { describe, it, expect } from 'vitest';
import {
  isDeadRoute, routePrefix, recordRouteOutcome, routeSnapshot, resetRouteMemory,
} from '../../data/engine/src/routeGuardMemory.js';

it('routePrefix: memotong sebelum garis miring pertama', () => {
  expect(routePrefix('ah/coding-glm-5.3-free')).toBe('ah');
  expect(routePrefix('nfh/cx/gpt-5.6-luna')).toBe('nfh');
  expect(routePrefix('gcli/grok-4.6')).toBe('gcli');
  expect(routePrefix('tanpa-garis-miring')).toBe(null);
  expect(routePrefix('')).toBe(null);
  expect(routePrefix(null)).toBe(null);
  expect(routePrefix(undefined)).toBe(null);
  expect(routePrefix(123)).toBe(null);
});

it('jalur yang diketahui busuk langsung dikenali', () => {
  resetRouteMemory();
  const ah = isDeadRoute('ah/coding-glm-5.3-free');
  expect(ah, 'ah/* harus dikenali sebagai jalur penyaring').toBeTruthy();
  expect(ah.prefix).toBe('ah');
  expect(ah.kind).toBe('dead');
  expect(ah.evidence.length > 0, 'wajib ada bukti, bukan cuma label').toBeTruthy();

  const nfh = isDeadRoute('nfh/cx/gpt-5.6-luna');
  expect(nfh.kind).toBe('filtered');
});

it('jalur bersih dan model baru TIDAK dihukum', () => {
  resetRouteMemory();
  expect(isDeadRoute('gcli/grok-4.6')).toBe(null);
  expect(isDeadRoute('cbcn/deepseek-v4-pro')).toBe(null);
  // Model yang belum ada pun harus lolos — itu inti desainnya.
  expect(isDeadRoute('misteri/model-baru-2027')).toBe(null);
});

it('jalur asing ditandai busuk SETELAH 3 penyaringan — tanpa daftar manual', () => {
  resetRouteMemory();
  const m = 'jalur-baru/model-x';
  recordRouteOutcome(m, 'FILTER_UPSTREAM');
  recordRouteOutcome(m, 'FILTER_UPSTREAM');
  expect(isDeadRoute(m)).toBe(null, '2 penyaringan belum cukup');
  recordRouteOutcome(m, 'FILTER_UPSTREAM');
  const hit = isDeadRoute(m);
  expect(hit, '3 penyaringan harus menandai jalur').toBeTruthy();
  expect(hit.kind).toBe('filtered');
  expect(hit.evidence).toMatch(/runtime/);
});

it('campuran segat + nolak juga dihitung', () => {
  resetRouteMemory();
  const m = 'jalur-campur/model-y';
  recordRouteOutcome(m, 'FILTER_UPSTREAM');
  recordRouteOutcome(m, 'NOLAK');
  recordRouteOutcome(m, 'NOLAK');
  expect(isDeadRoute(m), '1 segat + 2 nolak = 3 penyaringan').toBeTruthy();
});

it('jalur yang mulai BEKERJA dibersihkan — catatan busuk tidak kekal', () => {
  resetRouteMemory();
  const m = 'jalur-pulih/model-z';
  recordRouteOutcome(m, 'FILTER_UPSTREAM');
  recordRouteOutcome(m, 'FILTER_UPSTREAM');
  recordRouteOutcome(m, 'FILTER_UPSTREAM');
  expect(isDeadRoute(m), 'awalnya busuk').toBeTruthy();

  recordRouteOutcome(m, 'PATUH');
  expect(isDeadRoute(m)).toBe(null, 'setelah PATUH, catatan busuk harus hilang');
});

it('kelas non-jalur tidak mempengaruhi hitungan jalur', () => {
  resetRouteMemory();
  const m = 'jalur-netral/model-w';
  for (let i = 0; i < 10; i++) recordRouteOutcome(m, 'SENYAP');
  expect(isDeadRoute(m)).toBe(null, 'SENYAP urusan model, bukan jalur');
  for (let i = 0; i < 10; i++) recordRouteOutcome(m, 'SUBSTITUSI');
  expect(isDeadRoute(m)).toBe(null, 'SUBSTITUSI urusan model, bukan jalur');
  for (let i = 0; i < 10; i++) recordRouteOutcome(m, 'AMBIGU');
  expect(isDeadRoute(m)).toBe(null, 'AMBIGU urusan model, bukan jalur');
});

it('prefix kosong/null diabaikan, tidak crash', () => {
  resetRouteMemory();
  recordRouteOutcome(null, 'NOLAK');
  recordRouteOutcome(undefined, 'NOLAK');
  recordRouteOutcome('tanpa-slash', 'NOLAK');
  expect(routeSnapshot().counters.length).toBe(0);
});

it('snapshot melaporkan seed + temuan runtime', () => {
  resetRouteMemory();
  const m = 'jalur-lapor/model-v';
  recordRouteOutcome(m, 'NOLAK');
  recordRouteOutcome(m, 'NOLAK');
  recordRouteOutcome(m, 'NOLAK');
  const snap = routeSnapshot();
  expect(snap.seed.includes('ah')).toBeTruthy();
  expect(snap.seed.includes('nfh')).toBeTruthy();
  expect(snap.learned.some(l => l.prefix === 'jalur-lapor')).toBeTruthy();
  // Jalur yang sudah diketahui busuk dari pengukuran TIDAK dihitung lagi: kalau
  // ikut dihitung, counter `ah` naik tanpa henti (45 endpoint hidup, tiap
  // request), dan snapshot jadi sampah diagnostik.
  expect(!snap.counters.some(c => c.prefix === 'ah'), 'jalur yang sudah di-seed tidak boleh masuk counter').toBeTruthy();
  expect(!snap.learned.some(l => l.prefix === 'ah'), 'jalur yang sudah di-seed tidak perlu ditandai ulang').toBeTruthy();
});

it('jalur yang sudah di-seed tidak menambah counter walau dibombardir', () => {
  resetRouteMemory();
  for (let i = 0; i < 50; i++) recordRouteOutcome('ah/coding-glm-5.3-free', 'NOLAK');
  for (let i = 0; i < 50; i++) recordRouteOutcome('nfh/cx/gpt-5.6-luna', 'FILTER_UPSTREAM');
  const snap = routeSnapshot();
  expect(snap.counters.length).toBe(0, `counter seharusnya kosong, isinya: ${JSON.stringify(snap.counters)}`);
  expect(snap.learned.length).toBe(0, 'jalur seed tidak perlu ditandai ulang');
  // Dan tetap dikenali sebagai busuk.
  expect(isDeadRoute('ah/x')).toBeTruthy();
  expect(isDeadRoute('nfh/y')).toBeTruthy();
});
