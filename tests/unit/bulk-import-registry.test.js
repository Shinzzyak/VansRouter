import { test, expect } from "vitest";
import { BULK_IMPORT_PROVIDERS, isValidBulkImportProvider } from "../../src/lib/oauth/services/bulkImportRegistry.js";

test("registry kiro-only", () => {
  expect(isValidBulkImportProvider("kiro")).toBe(true);
  expect(isValidBulkImportProvider("qoder")).toBe(false);
  expect(Object.keys(BULK_IMPORT_PROVIDERS)).toEqual(["kiro"]);
});

test("kiro manager exports", async () => {
  const m = await import("../../src/lib/oauth/services/kiroBulkImportManager.js");
  expect(typeof m.getKiroBulkImportManager).toBe("function");
  expect(typeof m.parseKiroBulkAccounts).toBe("function");
});
