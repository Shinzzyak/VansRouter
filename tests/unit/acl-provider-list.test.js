import { describe, it, expect } from "vitest";
import {
  getAclProviderList,
  AI_PROVIDERS,
  FREE_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
} from "@/shared/constants/providers";

describe("getAclProviderList (API key allowed-providers picker)", () => {
  const list = getAclProviderList();

  it("returns entries with the { alias, name, color } shape", () => {
    expect(list.length).toBeGreaterThan(0);
    for (const p of list) {
      expect(typeof p.alias).toBe("string");
      expect(p.alias.length).toBeGreaterThan(0);
      expect(typeof p.name).toBe("string");
      expect(p.name.length).toBeGreaterThan(0);
      expect(typeof p.color).toBe("string");
    }
  });

  it("is complete — covers every non-hidden provider alias in AI_PROVIDERS", () => {
    const expectedAliases = new Set(
      Object.values(AI_PROVIDERS)
        .filter((p) => p?.alias && !p.hidden)
        .map((p) => p.alias)
    );
    const actualAliases = new Set(list.map((p) => p.alias));
    expect(actualAliases).toEqual(expectedAliases);
  });

  it("includes representative providers from each category", () => {
    const aliases = new Set(list.map((p) => p.alias));
    // Free
    expect(aliases.has(FREE_PROVIDERS.kiro.alias)).toBe(true);   // kr
    expect(aliases.has(FREE_PROVIDERS.opencode.alias)).toBe(true); // oc
    // OAuth
    expect(aliases.has(OAUTH_PROVIDERS.github.alias)).toBe(true); // gh
    expect(aliases.has(OAUTH_PROVIDERS.kilocode.alias)).toBe(true); // kc
    // API key
    expect(aliases.has(APIKEY_PROVIDERS.openai.alias)).toBe(true); // openai
    expect(aliases.has(APIKEY_PROVIDERS.deepseek.alias)).toBe(true); // ds
    expect(aliases.has(APIKEY_PROVIDERS.glm.alias)).toBe(true); // glm
  });

  it("covers more providers than the old hardcoded list of 22", () => {
    expect(list.length).toBeGreaterThan(22);
  });

  it("has no duplicate aliases", () => {
    const aliases = list.map((p) => p.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("excludes hidden (media-only) providers", () => {
    const hiddenAliases = Object.values(AI_PROVIDERS)
      .filter((p) => p?.hidden && p.alias)
      .map((p) => p.alias);
    const actual = new Set(list.map((p) => p.alias));
    for (const a of hiddenAliases) {
      // only excluded if no other non-hidden provider shares the alias
      const sharedByVisible = Object.values(AI_PROVIDERS).some(
        (p) => p.alias === a && !p.hidden
      );
      if (!sharedByVisible) expect(actual.has(a)).toBe(false);
    }
  });

  it("is sorted alphabetically by display name", () => {
    const names = list.map((p) => p.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });
});
