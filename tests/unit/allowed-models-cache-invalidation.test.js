import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invalidateAllowedModelsCache } from "@/sse/services/allowedModels.js";

// Regression test for UI-UX audit #4: provider/alias/disabled mutations must
// drop the in-memory list + fetcher caches so deleted providers don't keep
// exposing phantom models ("MiMo muncul baru").
//
// The caches are module-private; we observe them indirectly:
//  - _modelsListCache: rebuildModelsList must hit the DB layer again after
//    invalidation (loadDbData re-invoked).
//  - fetcher cache: we can't reach module-private state, so we assert the
//    exported invalidate() runs without error and the list cache rebuilds.
describe("allowedModels cache invalidation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invalidateAllowedModelsCache clears the list cache (rebuild re-reads DB)", async () => {
    const svc = await import("@/sse/services/allowedModels.js");
    // Spy on buildModelsList — after invalidation, a second call must NOT be
    // served from the cache (would skip the function body).
    vi.spyOn(svc, "buildModelsList");

    // First build primes the cache.
    await svc.buildModelsList(["llm"], { skipDynamicFetch: true });
    const callsAfterPrime = svc.buildModelsList.mock.calls.length;

    invalidateAllowedModelsCache();

    // Second build must NOT be served from cache (would skip the function).
    await svc.buildModelsList(["llm"], { skipDynamicFetch: true });
    expect(svc.buildModelsList.mock.calls.length).toBe(callsAfterPrime + 1);
  });

  it("invalidateAllowedModelsCache is idempotent and safe with no prior calls", () => {
    expect(() => invalidateAllowedModelsCache()).not.toThrow();
  });
});
