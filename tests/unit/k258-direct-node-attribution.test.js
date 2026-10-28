/**
 * K258 — direct-path node attribution.
 *
 * Combo mode recorded a verdict per candidate node; the direct path (no combo,
 * no smart-fallback — one model straight at the router) recorded nothing. So a
 * refusal arriving from provider A and the same refusal from provider B both
 * landed as a single model-level loss, and the wall could not answer the only
 * question that matters:
 *
 *     is the MODEL refusing, or is this PROVIDER's baked system prompt?
 *
 * Same model on two nodes, one refuses and one does not => the model is fine,
 * the node is the problem. Same model on every node refusing => the model (or
 * its default prompt everywhere) is the problem.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { noteNodeVerdict, wallVerdict, resetProviderWall, nodesForModel } from 'open-sse/rtk/providerWall.js';

const src = fs.readFileSync(path.resolve(process.cwd(), 'open-sse/handlers/chatCore.js'), 'utf8');

describe('K258 — direct path writes per-node verdicts', () => {
  it('imports the provider-wall API', () => {
    expect(src).toMatch(/from "\.\.\/rtk\/providerWall\.js"/);
    expect(src).toContain('noteNodeVerdict');
  });

  it('calls recordNodeVerdict on every classification site', () => {
    const calls = src.match(/recordNodeVerdict\(/g) || [];
    // 1 definition + 5 escalation/delivery sites + 1 in the wall-log block.
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  it('logs the wall when a refusal has no alternative node', () => {
    expect(src).toContain('explainWall(model)');
    expect(src).toContain('no swap possible, this is the provider system prompt');
  });

  it('does not auto-swap the model on refusal', () => {
    // The genome ladder owns the first moves; a blind model swap hides the
    // provider-prompt finding this change exists to expose.
    expect(src).not.toMatch(/noteNodeVerdict[\s\S]{0,200}switchModel|switchModel[\s\S]{0,200}noteNodeVerdict/);
  });
});

describe('K258 — the wall names the RIGHT suspect', () => {
  it('same model, one node refuses and its twin ships => provider-prompt', () => {
    resetProviderWall?.();
    const M = 'k258-twin';
    for (let i = 0; i < 2; i++) noteNodeVerdict({ provider: 'alpha', model: M, verdict: 'refused' });
    for (let i = 0; i < 2; i++) noteNodeVerdict({ provider: 'beta', model: M, verdict: 'accepted' });
    expect(wallVerdict(M)).toBe('provider-prompt');
    // Both nodes are kept: rotating the MODEL would throw away a working lane.
    expect(nodesForModel(M).length).toBe(2);
  });

  it('every node refusing => model', () => {
    resetProviderWall?.();
    const M = 'k258-all-refuse';
    for (const p of ['alpha', 'beta']) {
      for (let i = 0; i < 2; i++) noteNodeVerdict({ provider: p, model: M, verdict: 'refused' });
    }
    expect(wallVerdict(M)).toBe('model');
  });

  it('one node only => unknown, never a guess', () => {
    resetProviderWall?.();
    const M = 'k258-single';
    for (let i = 0; i < 5; i++) noteNodeVerdict({ provider: 'alpha', model: M, verdict: 'refused' });
    expect(wallVerdict(M)).toBe('unknown');
  });

  it('nodesForModel returns a list, never undefined', () => {
    expect(Array.isArray(nodesForModel('k258-probe'))).toBe(true);
  });
});
