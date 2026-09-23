// Guard for PROVIDER_ALIAS_TO_ID — the small local alias table in capabilities.js.
//
// WHY THIS TEST EXISTS. `PROVIDER_CAPABILITIES` is keyed by provider ID, but
// callers disagree about which spelling they pass:
//
//   /api/models      passes the ALIAS  (m.provider as stored → "kr", "cbai")
//   combo.js         passes the ALIAS  (the combo member string → "kr", "cbai")
//   /v1/models       passes the ID     (providerId → "kiro", "codebuddy-intl")
//
// Before the table existed, the same model resolved to two different context
// windows depending on the surface. Measured 2026-09-22: 49 rows disagreed, and
// combo.js — the path that actually decides capacity/compaction — read 1500000
// for providers whose real ceiling is 272000.
//
// The table is hand-written on purpose (importing the registry here would pull
// 161 registry files into the client bundle, since
// src/shared/hooks/useModelCaps.js imports capabilities.js). This test is what
// keeps a hand-written table honest: it recomputes the alias→id pairs from the
// registry and fails if the two disagree for any key this table claims.
import { describe, it, expect } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import {
  PROVIDER_ALIAS_TO_ID,
  PROVIDER_CAPABILITIES,
  getCapabilitiesForModel,
} from "../../open-sse/providers/capabilities.js";

/** alias → id, derived from the registry (single source of truth). */
function registryAliasPairs() {
  const out = {};
  for (const entry of REGISTRY) {
    for (const alias of [entry.alias, ...(entry.aliases || [])]) {
      if (!alias || alias === entry.id) continue;
      if (!out[alias]) out[alias] = entry.id;
    }
  }
  return out;
}

describe("PROVIDER_ALIAS_TO_ID", () => {
  const fromRegistry = registryAliasPairs();

  it("maps every alias it claims to the id the registry actually declares", () => {
    for (const [alias, id] of Object.entries(PROVIDER_ALIAS_TO_ID)) {
      if (alias === id) continue; // identity rows are assertions about itself
      expect(
        fromRegistry[alias],
        `alias "${alias}" is mapped to "${id}" but the registry says "${fromRegistry[alias]}"`,
      ).toBe(id);
    }
  });

  it("covers every alias that points at a PROVIDER_CAPABILITIES key", () => {
    // The failure this prevents: a new alias is added to a registry entry whose
    // id has a PROVIDER_CAPABILITIES block, and nobody adds the alias here — so
    // that provider silently answers with the pattern/catalog value on the alias
    // surfaces and the override value on the id surface. That is exactly the
    // split this table exists to close.
    const missing = [];
    for (const [alias, id] of Object.entries(fromRegistry)) {
      if (!PROVIDER_CAPABILITIES[id]) continue;
      if (!PROVIDER_ALIAS_TO_ID[alias]) missing.push(`${alias} → ${id}`);
    }
    expect(missing, `alias(es) missing from PROVIDER_ALIAS_TO_ID: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no stale row pointing at a provider the registry does not know", () => {
    const ids = new Set(REGISTRY.map((r) => r.id));
    for (const id of Object.values(PROVIDER_ALIAS_TO_ID)) {
      expect(ids.has(id), `PROVIDER_ALIAS_TO_ID points at unknown provider id "${id}"`).toBe(true);
    }
  });
});

describe("alias and provider id resolve to the same capabilities", () => {
  // These are the pairs that actually disagreed in production. A window is used
  // as the probe because it is the field that leaked into /v1/models
  // context_length and into combo.js's capacity decision.
  const PAIRS = [
    ["kr", "kiro"],
    ["cx", "codex"],
    ["cbai", "codebuddy-intl"],
    ["cbcn", "codebuddy-cn"],
    ["atr", "atria"],
  ];

  it.each(PAIRS)("%s and %s agree on the context window", (alias, id) => {
    const viaAlias = getCapabilitiesForModel(alias, "gpt-5.6-luna").contextWindow;
    const viaId = getCapabilitiesForModel(id, "gpt-5.6-luna").contextWindow;
    expect(viaAlias).toBe(viaId);
  });

  it("a provider override still wins over the model entry, through the alias", () => {
    // kiro/codex cap luna at 272k; the model entry says 1.5M. Reaching the
    // override through the alias is the whole point of the table.
    expect(getCapabilitiesForModel("kr", "gpt-5.6-luna").contextWindow).toBe(272000);
    expect(getCapabilitiesForModel("cx", "gpt-5.6-luna").contextWindow).toBe(272000);
    expect(getCapabilitiesForModel("cbai", "gpt-5.6-luna").contextWindow).toBe(400000);
  });

  it("an unknown provider string still falls through to the model entry", () => {
    // No alias, no override — must not be treated as an error or as a mismatch.
    expect(getCapabilitiesForModel("provider-yang-tidak-ada", "gpt-5.6-luna").contextWindow)
      .toBe(getCapabilitiesForModel(null, "gpt-5.6-luna").contextWindow);
  });
});
