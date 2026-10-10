// Guard for the per-API-key model allowlist (9router-go F-7 parity).
//
// The invariant under test: an EMPTY allowlist allows everything (so every key
// minted before this feature is unaffected), a non-empty one is matched with the
// model resolver's own glob matcher, and the same decision function is used by
// dispatch and by listing.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  cleanModelPatterns,
  validateModelAllowlist,
  parseModelAllowlistBody,
  MAX_ALLOWLIST_ENTRIES,
  MAX_ALLOWLIST_ENTRY_LENGTH,
} from "@/lib/db/repos/apiKeyModelAccessRepo.js";
import { matchesModelAllowlist } from "@/sse/services/allowedModels.js";

const root = resolve(__dirname, "../..");

describe("model allowlist parsing", () => {
  it("trims entries and drops blanks", () => {
    expect(cleanModelPatterns([" a ", "", "  ", "b"])).toEqual(["a", "b"]);
    expect(cleanModelPatterns("not-an-array")).toEqual([]);
    expect(cleanModelPatterns([1, null, "ok"])).toEqual(["ok"]);
  });

  it("accepts the wrapped and the bare array form", () => {
    expect(parseModelAllowlistBody({ models: ["a", " b "] })).toEqual({ ok: true, models: ["a", "b"] });
    expect(parseModelAllowlistBody(["a"])).toEqual({ ok: true, models: ["a"] });
    expect(parseModelAllowlistBody(null)).toEqual({ ok: true, models: [] });
  });

  it("rejects a non-array models value", () => {
    const r = parseModelAllowlistBody({ models: "a" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/string array/);
  });

  it("bounds entry count and entry length", () => {
    const many = Array.from({ length: MAX_ALLOWLIST_ENTRIES + 1 }, (_, i) => `m${i}`);
    expect(validateModelAllowlist(many).ok).toBe(false);
    expect(validateModelAllowlist(Array(MAX_ALLOWLIST_ENTRIES).fill("m")).ok).toBe(true);
    expect(validateModelAllowlist(["x".repeat(MAX_ALLOWLIST_ENTRY_LENGTH + 1)]).ok).toBe(false);
  });
});

describe("matchesModelAllowlist decision", () => {
  it("allows everything when no allowlist is configured", () => {
    expect(matchesModelAllowlist("za/glm-5.3-flash", null)).toBe(true);
    expect(matchesModelAllowlist("za/glm-5.3-flash", {})).toBe(true);
    expect(matchesModelAllowlist("za/glm-5.3-flash", { allowedModels: [] })).toBe(true);
  });

  it("matches the provider-qualified and the bare spelling", () => {
    const key = { allowedModels: ["glm-5.3-flash"] };
    expect(matchesModelAllowlist("za/glm-5.3-flash", key)).toBe(true);
    expect(matchesModelAllowlist("glm-5.3-flash", key)).toBe(true);
    expect(matchesModelAllowlist("za/gpt-5", key)).toBe(false);
  });

  it("supports glob patterns and is case-insensitive", () => {
    expect(matchesModelAllowlist("za/glm-5.3-flash", { allowedModels: ["za/*"] })).toBe(true);
    expect(matchesModelAllowlist("GLM-5.3-Flash", { allowedModels: ["glm-*"] })).toBe(true);
    expect(matchesModelAllowlist("skg/other", { allowedModels: ["za/*"] })).toBe(false);
  });

  it("ignores blank patterns instead of allowing everything", () => {
    expect(matchesModelAllowlist("za/x", { allowedModels: ["  "] })).toBe(false);
  });
});

describe("F-7 wiring", () => {
  it("declares the table and bumps the schema version", () => {
    const schema = readFileSync(resolve(root, "src/lib/db/schema.js"), "utf8");
    expect(schema).toMatch(/apiKeyModelAccess:/);
    expect(schema).toMatch(/PRIMARY KEY \(apiKeyId, model\)/);
    expect(schema).toMatch(/SCHEMA_VERSION = 13/);
  });

  it("registers the migration", () => {
    const idx = readFileSync(resolve(root, "src/lib/db/migrations/index.js"), "utf8");
    expect(idx).toMatch(/009-add-api-key-model-access\.js/);
    expect(existsSync(resolve(root, "src/lib/db/migrations/009-add-api-key-model-access.js"))).toBe(true);
  });

  it("ships the dashboard route", () => {
    const p = resolve(root, "src/app/api/keys/[id]/models/route.js");
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, "utf8");
    expect(src).toMatch(/export async function GET/);
    expect(src).toMatch(/export async function PUT/);
  });

  it("loads the allowlist on key validation and enforces it on dispatch", () => {
    const repo = readFileSync(resolve(root, "src/lib/db/repos/apiKeysRepo.js"), "utf8");
    expect(repo).toMatch(/apiKey\.allowedModels = await getAllowedModels/);
    const chat = readFileSync(resolve(root, "src/sse/handlers/chat.js"), "utf8");
    expect(chat).toMatch(/isModelAllowed\(/);
    const listing = readFileSync(resolve(root, "src/app/api/v1/models/route.js"), "utf8");
    expect(listing).toMatch(/matchesModelAllowlist\(model\.id, apiKeyInfo\)/);
  });
});
