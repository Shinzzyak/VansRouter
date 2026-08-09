import { describe, it, expect } from "vitest";
import {
  BULK_IMPORT_PROVIDERS,
  getBulkImportProviderSpec,
  isValidBulkImportProvider,
} from "@/lib/oauth/services/bulkImportRegistry.js";

describe("bulk-import registry — grok-cli", () => {
  it("registers grok-cli provider", () => {
    expect(isValidBulkImportProvider("grok-cli")).toBe(true);
    const spec = getBulkImportProviderSpec("grok-cli");
    expect(spec.label).toBe("Grok CLI");
  });

  it("normalizeStartArgs passes yyds fields", () => {
    const spec = getBulkImportProviderSpec("grok-cli");
    const args = spec.normalizeStartArgs(
      {
        registerCount: 3,
        mailProvider: "yyds",
        yydsApiKey: "AC-test",
        mailDomains: "zchyur.my.id",
      },
      { proxyUrl: null, proxyUrls: [], proxyMode: "none", proxyPoolId: null, proxySource: null },
    );
    expect(args.registerCount).toBe(3);
    expect(args.mailProvider).toBe("yyds");
    expect(args.yydsApiKey).toBe("AC-test");
  });

  it("loads grok manager via dynamic import", async () => {
    const spec = getBulkImportProviderSpec("grok-cli");
    const manager = await spec.getManager();
    expect(manager).toBeTruthy();
  });
});
