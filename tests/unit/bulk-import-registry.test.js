import { test, expect } from "vitest";
import { BULK_IMPORT_PROVIDERS, isValidBulkImportProvider } from "../../src/lib/oauth/services/bulkImportRegistry.js";

test("registry kiro + grok-cli + qoder/codebuddy/autoclaw", () => {
  expect(isValidBulkImportProvider("kiro")).toBe(true);
  expect(isValidBulkImportProvider("grok-cli")).toBe(true);
  expect(isValidBulkImportProvider("qoder")).toBe(true);
  expect(isValidBulkImportProvider("codebuddy")).toBe(true);
  expect(isValidBulkImportProvider("codebuddy-cn")).toBe(true);
  expect(isValidBulkImportProvider("autoclaw")).toBe(true);
  expect(isValidBulkImportProvider("autoclaw-signup")).toBe(true);
  expect(isValidBulkImportProvider("qoder-signup")).toBe(true);
  expect(isValidBulkImportProvider("baseten-signup")).toBe(true);
  expect(isValidBulkImportProvider("cloudflare-ai")).toBe(false);
  expect(isValidBulkImportProvider("unknown")).toBe(false);
  expect(Object.keys(BULK_IMPORT_PROVIDERS).sort()).toEqual([
    "autoclaw",
    "autoclaw-signup",
    "baseten-signup",
    "codebuddy",
    "codebuddy-cn",
    "grok-cli",
    "kiro",
    "outlook-signup",
    "qoder",
    "qoder-signup",
    "tokenharbor-signup",
  ]);
  expect(isValidBulkImportProvider("tokenharbor-signup")).toBe(true);
  expect(isValidBulkImportProvider("outlook-signup")).toBe(true);
});

test("registry outlook-signup has mode passthrough", () => {
  const spec = BULK_IMPORT_PROVIDERS["outlook-signup"];
  expect(spec.label).toBe("Outlook Signup");
  const args = spec.normalizeStartArgs(
    { registerCount: 3, concurrency: 2, outlookMode: "headless" },
    { proxyUrl: "http://1.2.3.4:8080" }
  );
  expect(args.registerCount).toBe(3);
  expect(args.mode).toBe("headless");
  expect(args.proxyUrl).toBe("http://1.2.3.4:8080");
});

test("kiro manager exports", async () => {
  const m = await import("../../src/lib/oauth/services/kiroBulkImportManager.js");
  expect(typeof m.getKiroBulkImportManager).toBe("function");
  expect(typeof m.parseKiroBulkAccounts).toBe("function");
});
