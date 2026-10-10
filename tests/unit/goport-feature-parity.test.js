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

  // The six cases of the Go oracle, providers.IsFreeTierModel
  // (internal/handlers/dashboard/combos_test.go). Kept identical so the two
  // implementations cannot drift on the `kilo-auto/free` shape.
  it("mirrors the Go oracle's suffix table", () => {
    expect(isFreeTierModelId("deepseek-v4.1-flash:free")).toBe(true);
    expect(isFreeTierModelId("kilo-auto/free")).toBe(true);
    expect(isFreeTierModelId("mimo-v2.5-free")).toBe(true);
    expect(isFreeTierModelId("free-tier-proxy")).toBe(false);
    expect(isFreeTierModelId("free")).toBe(false);
    expect(isFreeTierModelId("")).toBe(false);
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

  it("caps expose the free flag from the shared free-tier rule", () => {
    const src = readFileSync(resolve(root, "src/app/api/models/caps/route.js"), "utf8");
    expect(src).toMatch(/isFreeTierModelId/);
    expect(src).toMatch(/free: isFreeTierModelId\(id\)/);
  });

  it("auto combos build from the published catalog", () => {
    const src = readFileSync(resolve(root, "src/lib/autoCombos.js"), "utf8");
    expect(src).toMatch(/buildModelsList\(\[LLM_KIND\]/);
    expect(src).toMatch(/invalidateAllowedModelsCache\(\)/);
  });

  it("version aliases re-export the handler and nothing else", () => {
    for (const p of ["status", "check"]) {
      const src = readFileSync(resolve(root, `src/app/api/version/${p}/route.js`), "utf8");
      expect(src).toMatch(/export \{ GET \} from "\.\.\/route\.js"/);
    }
  });

  it("a proxy-pool probe stores its latency, so the list can rank by speed", () => {
    const src = readFileSync(resolve(root, "src/app/api/proxy-pools/[id]/test/route.js"), "utf8");
    expect(src).toMatch(/latency/);
    // 0 on failure: "no measurement", not "instant".
    expect(src).toMatch(/result\.ok \? \(result\.elapsedMs \|\| 0\) : 0/);
  });

  it("the proxy-pools page can test every pool and show the latency badge", () => {
    const src = readFileSync(resolve(root, "src/app/(dashboard)/dashboard/proxy-pools/page.js"), "utf8");
    expect(src).toMatch(/handleTestAll/);
    expect(src).toMatch(/getLatencyBadge/);
    // Go thresholds: <300 fast, <=800 tolerable, above slow.
    expect(src).toMatch(/ms < 300/);
    expect(src).toMatch(/ms <= 800/);
  });

  it("cache admin can drop one entry by signature, not only a whole model", () => {
    const src = readFileSync(resolve(root, "src/app/api/cache/route.js"), "utf8");
    expect(src).toMatch(/searchParams\.get\("signature"\)/);
    expect(src).toMatch(/defaultCache\.deleteEntry\(signature\)/);
  });

  it("console logs expose the level the line was emitted at", () => {
    const src = readFileSync(resolve(root, "src/app/api/translator/console-logs/route.js"), "utf8");
    expect(src).toMatch(/getConsoleLogEntries\(\)/);
    // The bare-string list stays: the deployed console page reads it.
    expect(src).toMatch(/^\s+logs,$/m);
  });

  it("the usage page carries the cache and compression sections", () => {
    const src = readFileSync(resolve(root, "src/app/(dashboard)/dashboard/usage/page.js"), "utf8");
    expect(src).toMatch(/CacheSection/);
    expect(src).toMatch(/CompressionSection/);
    // The logs tab predates them and must survive the edit.
    expect(src).toMatch(/"overview", "logs", "details", "cache", "compression"/);
  });
});
