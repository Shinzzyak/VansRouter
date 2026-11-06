import { describe, it, expect } from 'vitest';
import {
  SIGNATURE_DEFAULT,
  PROBE_LANGUAGES,
  buildProbePrompts,
  parseNumber,
  distributionFromAnswers,
  fingerprint,
  cosine,
  compareFingerprints,
  buildCatalog,
  nearestLineage,
} from '../../data/engine/src/modelFingerprint.js';

describe('modelFingerprint — One Token Is Enough', () => {
  it('probe prompts ada EMPAT bahasa, bukan satu', () => {
    expect(PROBE_LANGUAGES.length).toBe(4);
    const langs = PROBE_LANGUAGES.map((p) => p.lang);
    expect(langs).toEqual(['en', 'id', 'zh', 'ar']);
    expect(buildProbePrompts()).toHaveLength(4);
  });

  it('parseNumber ambil angka dari jawaban longgar', () => {
    expect(parseNumber('42')).toBe(42);
    expect(parseNumber('the number is 7')).toBe(7);
    expect(parseNumber('١٠٠')).toBe(100); // Arabic-Indic
    expect(parseNumber('I refuse to answer.')).toBe(null);
    expect(parseNumber('999')).toBe(null); // di luar 1..100
  });

  it('distributionFromAnswers hitung real, skip sampah', () => {
    const { counts, seen } = distributionFromAnswers(['3', '3', 'x', '77']);
    expect(seen).toBe(3);
    expect(counts.get(3)).toBe(2);
    expect(counts.get(77)).toBe(1);
    expect(counts.get('x')).toBeUndefined();
  });

  it('fingerprint ternormalisasi (jumlah ≈ 1) dan panjang = buckets', () => {
    const fp = fingerprint(['10', '50', '90', '90'], { buckets: 20 });
    expect(fp.vector).toHaveLength(20);
    const sum = [...fp.vector].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(fp.n).toBe(4);
  });

  it('cosine: identik = 1, ortogonal = 0', () => {
    const a = new Float64Array([1, 0, 0]);
    expect(cosine(a, a)).toBeCloseTo(1, 10);
    const b = new Float64Array([0, 1, 0]);
    expect(cosine(a, b)).toBeCloseTo(0, 10);
  });

  it('fingerprint dari dua set sampel sama → memperkirakan match', () => {
    // Distribusi deterministik berbeda jelas → dua "model" terpisah.
    const uniform = new Array(100).fill(0).map((_, i) => String(i + 1));
    const biased = new Array(100).fill('7');
    const fu = fingerprint(uniform);
    const fb = fingerprint(biased);
    const verdict = compareFingerprints(fu, fb, SIGNATURE_DEFAULT.threshold);
    expect(verdict.isMatch).toBe(false);
    expect(verdict.similarity).toBeLessThan(0.95);
  });

  it('fingerprint identik → match, dan sampel kosong TIDAK pernah match', () => {
    const samples = ['1', '1', '2', '3', '99'];
    const a = fingerprint(samples);
    const b = fingerprint(samples);
    const verdict = compareFingerprints(a, b, SIGNATURE_DEFAULT.threshold);
    expect(verdict.similarity).toBeCloseTo(1, 10);
    expect(verdict.isMatch).toBe(true);

    const empty = fingerprint([]);
    const bad = compareFingerprints(empty, a, SIGNATURE_DEFAULT.threshold);
    expect(bad.isMatch).toBe(false);
    expect(bad.reason).toBe('empty-reference');
  });

  it('buildCatalog + nearestLineage pilih model terdekat', () => {
    const catalog = buildCatalog({
      modelA: new Array(100).fill('5'),
      modelB: new Array(100).fill(0).map((_, i) => String(i + 1)),
    });
    const probe = fingerprint(new Array(100).fill('5'));
    const hit = nearestLineage(probe, catalog);
    expect(hit.model).toBe('modelA');
    expect(hit.similarity).toBeCloseTo(1, 10);
  });
});