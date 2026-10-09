import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MEDIA } from "../../open-sse/providers/index.js";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";

describe("v1m System One provider", () => {
  const entry = REGISTRY.find((e) => e.id === "v1m");

  it("is registered as a System One apikey provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.serviceKinds).toEqual(["systemone"]);
    expect(PROVIDER_MEDIA["v1m"]?.systemoneConfig?.baseUrl).toBe("https://v1m.ir/v1/systemone");
  });

  it("appears in getProvidersByKind('systemone')", () => {
    const list = getProvidersByKind("systemone");
    const found = list.find((p) => p.id === "v1m");
    expect(found).toBeDefined();
    expect(found.alias).toBe("v1m");
    expect(found.systemoneConfig?.baseUrl).toBe("https://v1m.ir/v1/systemone");
  });

  it("exposes calibrated models", () => {
    const ids = (entry.models || []).map((m) => m.id);
    expect(ids).toContain("rev-latest");
    expect(ids).toContain("v1m-decision-engine");
  });

  // The upstream handler imported its session-id helper from a module that does
  // not exist in the upstream tree, which is why the lane never ran. Guard the
  // invariant instead of the shape: every specifier the handler imports must
  // resolve to a real file. A missing module is the failure mode that matters.
  it("handler imports only modules that exist", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const root = path.resolve(here, "../..");
    const src = fs.readFileSync(path.join(root, "open-sse/handlers/systemoneCore.js"), "utf8");

    const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);

    const missing = specifiers.filter((spec) => {
      const base = path.resolve(path.join(root, "open-sse/handlers"), spec);
      return !fs.existsSync(base) && !fs.existsSync(`${base}.js`) && !fs.existsSync(`${base}.mjs`);
    });
    expect(missing).toEqual([]);
  });

  // Wiring guard: the lane is only reachable if the route's handler module
  // actually resolves and exports the entry point. Upstream's version never
  // resolved, so nothing caught it.
  it("the /v1/systemone route resolves its handler", async () => {
    const mod = await import("@/sse/handlers/systemone.js");
    expect(typeof mod.handleSystemone).toBe("function");
    const route = await import("@/app/api/v1/systemone/route.js");
    expect(typeof route.POST).toBe("function");
  });
});
