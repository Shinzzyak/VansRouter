// Guard for the 9router-go feature-parity additions beyond the apiKeys surface:
// auto-generated combos, the capability matrix, semantic-cache admin, and the
// hello/version probes. Pure-module + file-existence tests — no DB, no network.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  isFreeTierModelId,
  modelFamily,
  MIN_FAMILY_MEMBERS,
  AUTO_FREE_COMBO_ID,
  AUTO_FAMILY_COMBO_KIND,
} from "@/lib/autoCombos.js";

const root = resolve(__dirname, "../..");

describe("free-tier detection", () => {
  it("matches the :free / -free / /free convention", () => {
    expect(isFreeTierModelId("za/glm-5.3-flash:free")).toBe(true);
    expect(isFreeTierModelId("oc/nemotron-3-ultra-free")).toBe(true);
    expect(isFreeTierModelId("nar/mimo-v2-6-flash:free")).toBe(true);
    expect(isFreeTierModelId("tia/glm-5.3-flash:free")).toBe(true);
  });

  it("does not match a paid model, and never throws on junk", () => {
    expect(isFreeTierModelId("za/glm-5.3-flash")).toBe(false);
    expect(isFreeTierModelId("")).toBe(false);
    expect(isFreeTierModelId(null)).toBe(false);
    expect(isFreeTierModelId(undefined)).toBe(false);
  });
});

describe("model family grouping", () => {
  it("drops the provider prefix", () => {
    expect(modelFamily("za/glm-5.3-flash")).toBe(modelFamily("skg/bansos/glm-5.3-flash"));
  });

  it("strips the free marker", () => {
    expect(modelFamily("tia/glm-5.3-flash:free")).toBe(modelFamily("za/glm-5.3-flash"));
  });

  it("strips version / size / quant noise", () => {
    expect(modelFamily("za/qwen3-235b")).toBe("qwen3");
    expect(modelFamily("za/qwen3-32b")).toBe("qwen3");
    expect(modelFamily("za/qwen3-v2.5")).toBe("qwen3");
    expect(modelFamily("za/qwen3-latest")).toBe("qwen3");
  });

  it("returns empty for junk so it can be skipped", () => {
    expect(modelFamily("")).toBe("");
    expect(modelFamily(null)).toBe("");
  });

  it("requires more than one member for a family combo", () => {
    expect(MIN_FAMILY_MEMBERS).toBeGreaterThan(1);
  });
});

describe("stable ids", () => {
  it("pins the free combo id so a rebuild upserts instead of duplicating", () => {
    expect(AUTO_FREE_COMBO_ID).toBe("auto-free-tier");
    expect(AUTO_FAMILY_COMBO_KIND).toBe("auto-family");
  });

  it("allows an explicit combo id through the repo", () => {
    const repo = readFileSync(resolve(root, "src/lib/db/repos/combosRepo.js"), "utf8");
    expect(repo).toMatch(/id: data\.id \|\| randomUUID\(\)/);
  });
});

describe("parity routes exist", () => {
  const routes = [
    "src/app/api/keys/[id]/models/route.js",
    "src/app/api/keys/[id]/rotate/route.js",
    "src/app/api/keys/[id]/toggle/route.js",
    "src/app/api/combos/auto-free/route.js",
    "src/app/api/combos/auto-family/route.js",
    "src/app/api/models/caps/route.js",
    "src/app/api/cache/route.js",
    "src/app/api/cache/entries/route.js",
    "src/app/api/hello/route.js",
    "src/app/api/version/status/route.js",
    "src/app/api/version/check/route.js",
  ];
  for (const r of routes) {
    it(r.replace("src/app", ""), () => {
      expect(existsSync(resolve(root, r))).toBe(true);
    });
  }
});

describe("parity routes are wired to real state, not stubs", () => {
  it("cache admin reads the live semantic cache", () => {
    const src = readFileSync(resolve(root, "src/app/api/cache/route.js"), "utf8");
    expect(src).toMatch(/defaultCache\.stats\(\)/);
    expect(src).toMatch(/defaultCache\.clear\(\)/);
  });

  it("caps come from the router's own capability source", () => {
    const src = readFileSync(resolve(root, "src/app/api/models/caps/route.js"), "utf8");
    expect(src).toMatch(/getCapabilitiesForModel/);
    expect(src).toMatch(/buildModelsList/);
  });

  it("auto combos build from the published catalog", () => {
    const src = readFileSync(resolve(root, "src/lib/autoCombos.js"), "utf8");
    expect(src).toMatch(/buildModelsList\(\[LLM_KIND\]/);
    expect(src).toMatch(/invalidateAllowedModelsCache\(\)/);
  });

  it("version aliases re-export instead of duplicating logic", () => {
    for (const p of ["status", "check"]) {
      const src = readFileSync(resolve(root, `src/app/api/version/${p}/route.js`), "utf8");
      expect(src).toMatch(/export \{ GET, dynamic \} from "\.\.\/route\.js"/);
    }
  });
});
