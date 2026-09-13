// Uji modelImmunityHints.
//
// Aturan yang dijaga: petunjuk ini TIDAK BOLEH melarang tingkat formulasi.
// Ia cuma menaikkan/menurunkan URUTAN. Dan hasil ukur sesi SELALU menang atas
// petunjuk klausa — pengukuran lapangan mengalahkan korelasi korpus.

import { describe, it, expect } from 'vitest';
import {
  immunityHint, suggestedFirstLevel, immunitySnapshot, IMMUNITY_HINTS,
} from '../../data/engine/src/modelImmunityHints.js';

// ── immunityHint: pengenalan keluarga ─────────────────────────────────────

it('mengenali keluarga dari nama model', () => {
  expect(immunityHint('cl/anthropic/claude-opus-4.7').family).toBe('anthropic');
  expect(immunityHint('gcli/grok-4.6').family).toBe('xai');
  expect(immunityHint('xki/mistral-medium-3.5').family).toBe('mistral');
  expect(immunityHint('fb/openai/gpt-5.6-luna').family).toBe('openai');
  expect(immunityHint('nar/llama-4-scout').family).toBe('meta');
});

it('model masa depan tetap dikenali tanpa memperbarui apa pun', () => {
  // Inti desainnya: id model baru membawa nama keluarga.
  expect(immunityHint('claude-opus-6.0-2027').family).toBe('anthropic');
  expect(immunityHint('grok-7-turbo').family).toBe('xai');
  expect(immunityHint('mistral-mega-9').family).toBe('mistral');
  expect(immunityHint('some/router/gpt-9-preview').family).toBe('openai');
});

it('keluarga tak dikenal mengembalikan null — bukan tebakan', () => {
  expect(immunityHint('cbcn/glm-5.3')).toBe(null);
  expect(immunityHint('deepseek/v4-pro')).toBe(null);
  expect(immunityHint('kimi/k2.7')).toBe(null);
  expect(immunityHint('misteri/model-2027')).toBe(null);
});

it('qwen dikenali (PATUH seragam 7/10)', () => {
  expect(immunityHint('qwen/qwen3.7-max').family).toBe('qwen');
});

it('input aneh tidak crash', () => {
  expect(immunityHint(null)).toBe(null);
  expect(immunityHint(undefined)).toBe(null);
  expect(immunityHint('')).toBe(null);
  expect(immunityHint(123)).toBe(null);
  expect(immunityHint({})).toBe(null);
});

it('setiap petunjuk membawa angka + bukti yang bisa diperiksa', () => {
  for (const [family, h] of Object.entries(IMMUNITY_HINTS)) {
    expect(h.uniformity, `${family} tanpa tingkat keseragaman`).toBeTruthy();
    expect(h.measured, `${family} tanpa angka hasil ukur`).toBeTruthy();
    expect(h.evidence, `${family} tanpa bukti — jadi dogma, bukan data`).toBeTruthy();
  }
});

it('KOREKSI: nol keluarga diklaim "kebal menolak" — itu temuan yang dibatalkan', () => {
  // Uji regresi untuk kesalahan analisis yang pernah dibuat: klaim "vendor
  // ber-klausa-penetral kebal formulasi" ternyata salah tafsir. Yang benar
  // mereka PATUH seragam. Tidak boleh ada field yang mengklaim kekebalan penolakan.
  for (const [family, h] of Object.entries(IMMUNITY_HINTS)) {
    expect(!('immunity' in h), `${family} masih memakai field 'immunity' lama`).toBeTruthy();
    const m = h.measured.toLowerCase();
    expect(!m.includes('kebal'), `${family} masih mengklaim 'kebal' — sudah dibantah data`).toBeTruthy();
  }
});

// ── suggestedFirstLevel: prioritas ────────────────────────────────────────

it('hasil ukur sesi SELALU menang atas petunjuk klausa', () => {
  // anthropic disarankan T1, tapi kalau sesi ini membuktikan T3 jalan, T3 menang.
  const r = suggestedFirstLevel('claude-opus-4.7', 'T3');
  expect(r.level).toBe('T3');
  expect(r.why).toMatch(/ukur/);
});

it('keluarga PATUH-seragam mulai dari T1 (paling murah), bukan T2', () => {
  const m = suggestedFirstLevel('mistral-large-3', null);
  expect(m.level).toBe('T1');
  expect(m.why).toMatch(/mistral/);
  const x = suggestedFirstLevel('gcli/grok-4.6', null);
  expect(x.level).toBe('T1');
  expect(x.why).toMatch(/xai/);
});

it('anthropic (uniformity medium, n kecil) TIDAK diarahkan — bukti terlalu tipis', () => {
  const a = suggestedFirstLevel('claude-opus-4.7', null, 'T2');
  expect(a.level).toBe('T2', 'n=12 dengan separuh tidak terukur tidak cukup untuk mengubah urutan');
});

it('keluarga tak dikenal memakai default — perilaku sebelum file ini ada', () => {
  const r = suggestedFirstLevel('cbcn/glm-5.3', null, 'T2');
  expect(r.level).toBe('T2');
  expect(r.why).toBe('default');
});

it('openai TIDAK diarahkan ke T1 walau angkanya di bawah rata-rata', () => {
  // Keluarga ini punya bukti LANGSUNG bahwa T2 menolong (gpt-5.6-luna:
  // T1=SUBSTITUSI -> T2=PATUH). Angka rendah tidak boleh menimpanya.
  const r = suggestedFirstLevel('fb/openai/gpt-5.6-luna', null, 'T2');
  expect(r.level).toBe('T2', 'openai harus tetap mulai dari T2');
});

// ── snapshot ──────────────────────────────────────────────────────────────

it('snapshot melaporkan seluruh keluarga terdaftar', () => {
  const snap = immunitySnapshot();
  expect(snap.length >= 4).toBeTruthy();
  expect(snap.every(s => s.family && s.uniformity && s.measured)).toBeTruthy();
});
