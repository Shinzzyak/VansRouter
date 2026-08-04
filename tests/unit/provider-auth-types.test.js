import { describe, expect, it } from "vitest";
import { getProviderAuthTypes } from "../../src/shared/utils/providerAuth.js";

describe("provider auth types", () => {
  it("uses declared auth modes for Kimchi OAuth and API-key connections", () => {
    expect(
      getProviderAuthTypes({ hasOAuth: true, authModes: ["apikey", "oauth"] }, "kimchi"),
    ).toEqual(["apikey", "oauth"]);
  });

  it("keeps Kiro API-key spelling compatibility", () => {
    expect(getProviderAuthTypes({}, "kiro")).toEqual(["oauth", "apikey", "api_key"]);
  });

  it("falls back to the provider OAuth capability", () => {
    expect(getProviderAuthTypes({ hasOAuth: true }, "provider")).toEqual(["oauth"]);
    expect(getProviderAuthTypes({}, "provider")).toEqual(["apikey"]);
  });
});
