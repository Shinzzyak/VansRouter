/**
 * K260 — direct mode gets a second model.
 *
 * The owner's premise: assume NO combo, NO smart-fallback. One model, straight
 * at the router. Today, when that model refuses, the genome ladder burns its
 * rungs on the same weights and then the refusal ships. Nothing in the request
 * path can reach a different model, because only combo owns model rotation.
 *
 * Order is the whole design:
 *   1. genome resample (same model, new frame)  — chatCore ladder
 *   2. node rotation (same model, other provider) — K257/K258 wall
 *   3. another model                            — this file
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fallbackChainFor, nextFallbackModel, MAX_FALLBACK_MODELS } from 'open-sse/services/modelFallback.js';

const chatSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/sse/handlers/chat.js'), 'utf8');
const coreSrc = fs.readFileSync(path.resolve(process.cwd(), 'open-sse/handlers/chatCore.js'), 'utf8');

describe('K260 — chain resolution', () => {
  it('is OFF when unset', () => {
    expect(fallbackChainFor('a', {})).toEqual([]);
    expect(fallbackChainFor('a', { refusalFallbackChain: null })).toEqual([]);
    expect(nextFallbackModel(['a'], {})).toBe(null);
  });

  it('array form applies to every model', () => {
    const s = { refusalFallbackChain: ['b', 'c'] };
    expect(fallbackChainFor('a', s)).toEqual(['b', 'c']);
  });

  it('map form is per-model, unknown model gets nothing', () => {
    const s = { refusalFallbackChain: { a: ['b'] } };
    expect(fallbackChainFor('a', s)).toEqual(['b']);
    expect(fallbackChainFor('z', s)).toEqual([]);
  });

  it('never returns the model that already failed', () => {
    expect(fallbackChainFor('a', { refusalFallbackChain: ['a', 'b'] })).toEqual(['b']);
    expect(nextFallbackModel(['a', 'b'], { refusalFallbackChain: ['b', 'c'] })).toBe('c');
  });

  it('caps rotation cost', () => {
    const many = Array.from({ length: 10 }, (_, i) => `m${i}`);
    expect(fallbackChainFor('a', { refusalFallbackChain: many }).length).toBe(MAX_FALLBACK_MODELS);
  });

  it('returns null once every configured model has been tried', () => {
    expect(nextFallbackModel(['a', 'b'], { refusalFallbackChain: ['b'] })).toBe(null);
  });

  it('junk input is ignored, not thrown', () => {
    expect(fallbackChainFor('a', { refusalFallbackChain: [null, 3, '', 'b'] })).toEqual(['b']);
    expect(fallbackChainFor(undefined, { refusalFallbackChain: ['b'] })).toEqual([]);
    expect(nextFallbackModel(null, {})).toBe(null);
  });
});

describe('K260 — wiring', () => {
  it('the direct path leaves through the fallback wrapper', () => {
    expect(chatSrc).toMatch(/return handleDirectWithModelFallback\(body, modelStr/);
  });

  it('the wrapper reads the verdict header, not the answer text', () => {
    expect(chatSrc).toContain('STREAM_VERDICT_HEADER');
    expect(chatSrc).toContain('nextFallbackModel(tried, settings)');
  });

  it('the wrapper only spends a swap on configured verdicts', () => {
    expect(chatSrc).toContain('refusalFallbackOn');
    expect(chatSrc).toMatch(/\[\"NOLAK\"\]\s*;/);
    expect(chatSrc).toMatch(/triggers\.includes\(verdict\)/);
  });

  it('a substitution can be stamped but is not a trigger by default', () => {
    expect(coreSrc).toContain('outcome !== \"NOLAK\" && outcome !== \"SUBSTITUSI\"');
    expect(coreSrc).toContain('headers.set(STREAM_VERDICT_HEADER, outcome);');
  });

  it('the non-streaming refusal exit stamps the verdict', () => {
    expect(coreSrc).toContain('return stampShippedVerdict(preEscalationResult, outcome, provider, model);');
  });

  it('a combo request never reaches the wrapper', () => {
    // Combos resolve earlier and return; the wrapper sits on the terminal
    // single-model return only.
    const comboCalls = (chatSrc.match(/handleComboChat\(/g) || []).length;
    expect(comboCalls).toBeGreaterThan(0);
    expect(chatSrc.indexOf('return handleDirectWithModelFallback')).toBeGreaterThan(chatSrc.indexOf('handleComboChat('));
  });
});
