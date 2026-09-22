// Guards for the capability resolver's two silent-failure modes.
//
//   1. An EXACT `MODEL_CAPABILITIES` entry used to return BEFORE refine(), so it
//      dropped both the pattern's fields and the models.dev catalog's limits.
//      Restoring gpt-5.6-luna's upstream entry that way turned vision off and
//      made stripUnsupportedModalities delete image blocks from the request.
//   2. `setCatalogSource` wrote a module-local variable. Next emits
//      capabilities.js TWICE into the standalone bundle (instrumentation runs in
//      its own webpack layer), so the install landed on one copy while every
//      route read the other — the catalog was parsed, written to disk, and
//      ignored until someone hit POST /api/models/catalog-sync.
//
// Both are fail-silent: no error, no log, just a smaller model.

import { describe, it, expect, afterEach } from "vitest";
import {
  getCapabilitiesForModel,
  setCatalogSource,
  MODEL_CAPABILITIES,
} from "../../open-sse/providers/capabilities.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const FAKE = {
  getModalities: (model) => (model === "guard-probe-model" ? { vision: true, pdf: true } : null),
  getLimits: (provider, model) =>
    provider === "guard-probe-provider" && model === "guard-probe-model"
      ? { contextWindow: 999000, maxOutput: 111000 }
      : null,
};

afterEach(() => setCatalogSource(null));

function imageBody() {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ],
  };
}

function imageKept(caps) {
  const body = imageBody();
  stripUnsupportedModalities(body, FORMATS.OPENAI, caps);
  return body.messages[0].content.some((b) => b.type === "image_url");
}

describe("exact MODEL_CAPABILITIES entries are refined", () => {
  // Synthetic model: only reachable through MODEL_CAPABILITIES, so the catalog
  // must reach it via refine(). Before the fix this returned the raw entry.
  const KEY = "guard-probe-model";
  const hadEntry = Object.prototype.hasOwnProperty.call(MODEL_CAPABILITIES, KEY);

  it("lets the catalog override limits on a model with an exact entry", () => {
    if (!hadEntry) MODEL_CAPABILITIES[KEY] = { reasoning: true, contextWindow: 200000, maxOutput: 64000 };
    try {
      setCatalogSource(FAKE);
      const caps = getCapabilitiesForModel("guard-probe-provider", KEY);
      expect(caps.contextWindow).toBe(999000);
      expect(caps.maxOutput).toBe(111000);
      expect(caps.vision).toBe(true);
      expect(caps.pdf).toBe(true);
    } finally {
      if (!hadEntry) delete MODEL_CAPABILITIES[KEY];
    }
  });

  it("keeps gpt-5.6-luna's pattern-supplied modalities after an exact entry is added", () => {
    // The entry exists; the pattern fields it does not restate must still be
    // present from the catalog/pattern path rather than silently false.
    const caps = getCapabilitiesForModel("tokenharbor", "gpt-5.6-luna");
    expect(caps.vision).toBe(true);
    expect(caps.search).toBe(true);
    expect(imageKept(caps)).toBe(true);
  });
});

describe("the catalog source is process-wide, not per bundle copy", () => {
  it("publishes the reader so a second module instance sees it", async () => {
    // Two imports with distinct query strings are two module instances — the
    // same shape Next produces when instrumentation gets its own chunk.
    const a = await import("../../open-sse/providers/capabilities.js?copy=a");
    const b = await import("../../open-sse/providers/capabilities.js?copy=b");
    expect(a.getCapabilitiesForModel).not.toBe(b.getCapabilitiesForModel);

    a.setCatalogSource(FAKE);
    try {
      // b never had setCatalogSource called on it.
      const viaB = b.getCapabilitiesForModel("guard-probe-provider", "guard-probe-model");
      expect(viaB.contextWindow).toBe(999000);
    } finally {
      a.setCatalogSource(null);
      expect(globalThis.__vrCatalogSource).toBeUndefined();
    }
  });

  it("clearing the source detaches it everywhere", () => {
    setCatalogSource(FAKE);
    expect(globalThis.__vrCatalogSource).toBeDefined();
    setCatalogSource(null);
    expect(globalThis.__vrCatalogSource).toBeUndefined();
  });
});
