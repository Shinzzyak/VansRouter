import { describe, it, expect } from "vitest";
import {
  AUTO_INTENTS,
  AUTO_CANDIDATE_LIMIT,
  AUTO_PER_PROVIDER_LIMIT,
  parseAutoTarget,
  applyExploration,
  buildAutoCandidates,
} from "open-sse/services/autoRouting.js";
import REGISTRY from "open-sse/providers/registry/index.js";

const CONN = (provider, extra = {}) => ({ id: `conn-${provider}`, provider, isActive: true, ...extra });
const NOW = Date.parse("2026-11-02T00:00:00Z");

describe("parseAutoTarget", () => {
  it("parses every intent, case-insensitively", () => {
    for (const intent of AUTO_INTENTS) {
      expect(parseAutoTarget(`auto:${intent}`)).toBe(intent);
      expect(parseAutoTarget(`AUTO:${intent.toUpperCase()}`)).toBe(intent);
      expect(parseAutoTarget(`  auto:${intent}  `)).toBe(intent);
    }
  });

  it("rejects unknown intents and non-auto strings", () => {
    expect(parseAutoTarget("auto:banana")).toBeNull();
    expect(parseAutoTarget("auto:coding:extra")).toBeNull();
    expect(parseAutoTarget("coding")).toBeNull();
    expect(parseAutoTarget("gpt-4")).toBeNull();
    expect(parseAutoTarget("provider/gpt-4")).toBeNull();
    expect(parseAutoTarget(null)).toBeNull();
    expect(parseAutoTarget(123)).toBeNull();
  });
});

describe("applyExploration", () => {
  it("is the identity when share is zero or the list is short", () => {
    const list = ["a", "b", "c", "d"];
    expect(applyExploration(list, { share: 0, seed: "x" })).toEqual(list);
    expect(applyExploration(["a"], { share: 1, seed: "x" })).toEqual(["a"]);
    expect(applyExploration([], { share: 1, seed: "x" })).toEqual([]);
  });

  it("is deterministic per seed and never drops or duplicates members", () => {
    const list = ["a", "b", "c", "d", "e"];
    const a = applyExploration(list, { share: 1, seed: "coding|2026-11-02" });
    const b = applyExploration(list, { share: 1, seed: "coding|2026-11-02" });
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([...list].sort());
  });
});

describe("buildAutoCandidates", () => {
  it("returns an empty list with no connections or an invalid intent", () => {
    expect(buildAutoCandidates({ intent: "coding", connections: [], now: NOW })).toEqual([]);
    expect(buildAutoCandidates({ intent: "banana", connections: [CONN("openai")] })).toEqual([]);
  });

  it("emits only real registry model ids, capped to the limit", () => {
    const providers = REGISTRY.filter((r) => Array.isArray(r.models) && r.models.length > 0).slice(0, 6);
    const connections = providers.map((r) => CONN(r.id));
    const out = buildAutoCandidates({ intent: "coding", connections, now: NOW });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(AUTO_CANDIDATE_LIMIT);
    for (const c of out) {
      const [prov, model] = c.split("/");
      const reg = REGISTRY.find((r) => r.id === prov);
      expect(reg, `provider ${prov} should exist in REGISTRY`).toBeTruthy();
      expect(reg.models.some((m) => m.id === model), `${c} should be a seeded model id`).toBe(true);
    }
  });

  it("caps each provider to AUTO_PER_PROVIDER_LIMIT candidates", () => {
    // Pick a registry provider with more than the limit of seed models.
    const fat = REGISTRY.find((r) => Array.isArray(r.models) && r.models.length > AUTO_PER_PROVIDER_LIMIT);
    if (!fat) return; // registry happens to have no fat provider — nothing to assert
    const others = REGISTRY.filter((r) => r.id !== fat.id && Array.isArray(r.models) && r.models.length > 0).slice(0, 4);
    const connections = [CONN(fat.id), ...others.map((r) => CONN(r.id))];
    const out = buildAutoCandidates({ intent: "cheap", connections, now: NOW });
    const fatCount = out.filter((c) => c.startsWith(`${fat.id}/`)).length;
    expect(fatCount).toBeLessThanOrEqual(AUTO_PER_PROVIDER_LIMIT);
  });

  it("honours the dashboard disabled list (by provider id and alias)", () => {
    const provider = REGISTRY.find((r) => Array.isArray(r.models) && r.models.length > 0 && (r.alias || (r.aliases || []).length));
    if (!provider) return;
    // Disable via the provider id.
    const allIds = provider.models.map((m) => m.id);
    const byId = buildAutoCandidates({
      intent: "coding",
      connections: [CONN(provider.id)],
      disabled: { [provider.id]: allIds },
      now: NOW,
    });
    expect(byId.filter((c) => c.startsWith(`${provider.id}/`))).toEqual([]);
    // Disable via the alias.
    const key = provider.alias || provider.aliases[0];
    const byAlias = buildAutoCandidates({
      intent: "coding",
      connections: [CONN(provider.id)],
      disabled: { [key]: allIds },
      now: NOW,
    });
    expect(byAlias.filter((c) => c.startsWith(`${provider.id}/`))).toEqual([]);
  });

  it("honours a connection's enabledModels whitelist", () => {
    const provider = REGISTRY.find((r) => Array.isArray(r.models) && r.models.length >= 2);
    if (!provider) return;
    const keep = provider.models[0].id;
    const out = buildAutoCandidates({
      intent: "coding",
      connections: [{ ...CONN(provider.id), providerSpecificData: { enabledModels: [keep] } }],
      now: NOW,
    });
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c).toBe(`${provider.id}/${keep}`);
    }
  });

  it("is deterministic for a fixed fleet and day", () => {
    const providers = REGISTRY.filter((r) => Array.isArray(r.models) && r.models.length > 0).slice(0, 5);
    const connections = providers.map((r) => CONN(r.id));
    const a = buildAutoCandidates({ intent: "headroom", connections, now: NOW, explorationShare: 0.05 });
    const b = buildAutoCandidates({ intent: "headroom", connections, now: NOW, explorationShare: 0.05 });
    expect(a).toEqual(b);
  });
});