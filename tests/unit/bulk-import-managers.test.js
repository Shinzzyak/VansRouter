import { test, expect } from "vitest";
import { BULK_IMPORT_PROVIDERS, isValidBulkImportProvider } from "../../src/lib/oauth/services/bulkImportRegistry.js";

test("all new managers load via registry getManager", async () => {
  const managers = await Promise.all(
    ["qoder", "codebuddy", "codebuddy-cn", "autoclaw"].map(async (id) => {
      const spec = BULK_IMPORT_PROVIDERS[id];
      const manager = await spec.getManager();
      return { id, manager };
    })
  );
  for (const { id, manager } of managers) {
    expect(manager, `${id} manager should resolve`).toBeTruthy();
  }
});

test("cloudflare-ai spec NOT registered (manager skipped - heavy python dep)", () => {
  expect(isValidBulkImportProvider("cloudflare-ai")).toBe(false);
});

test("codebuddy-cn spec passes fiveSimToken", () => {
  const spec = BULK_IMPORT_PROVIDERS["codebuddy-cn"];
  const args = spec.normalizeStartArgs(
    { fiveSimToken: "tok123", count: 3, country: "russia", operator: "any" },
    { proxyUrl: null, proxyUrls: [], proxyMode: "none", proxyPoolId: null, proxySource: null }
  );
  expect(args.fiveSimToken).toBe("tok123");
  expect(args.count).toBe(3);
});
