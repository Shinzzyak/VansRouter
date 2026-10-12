// Resale hardening (wave 2, migration 010) against a real throwaway database.
//
// These are the claims a seller would be sold on, so each one is asserted
// against real rows rather than a mock:
//   - allowedIps / tokenBalance / tokensSpent survive a write+read round trip
//   - a prepaid balance actually gates dispatch, and only balanced keys pay for
//     the accounting write
//   - a redeem code credits the balance, pushes expiry out, and burns exactly
//     one of its uses
//   - a top-up does NOT resurrect a key the admin switched off
//
// Live behaviour still needs the e2e harness (scripts/resale-e2e-live.py); this
// file pins the semantics those requests depend on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-resale-"));
  process.env.DATA_DIR = tempDir;
  // Fresh adapter per test: the driver keeps a module-level singleton.
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const load = async () => ({
  driver: await import("@/lib/db/driver.js"),
  migrations: await import("@/lib/db/migrations/index.js"),
  keys: await import("@/lib/db/repos/apiKeysRepo.js"),
  redeem: await import("@/lib/db/repos/redeemCodesRepo.js"),
  usage: await import("@/lib/db/repos/apiKeyUsageRepo.js"),
  details: await import("@/lib/db/repos/requestDetailsRepo.js"),
  mask: await import("@/lib/db/helpers/apiKeyMask.js"),
});

describe("migration 010 lands the resale columns and the redeem table", () => {
  it("adds allowedIps/tokenBalance/tokensSpent and creates redeemCodes", async () => {
    const { driver, migrations } = await load();
    const db = await driver.getAdapter();

    const columns = db.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["allowedIps", "tokenBalance", "tokensSpent"]));

    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map((t) => t.name);
    expect(tables).toContain("redeemCodes");

    const stamped = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(stamped.value, 10)).toBe(migrations.latestVersion());
  });

  it("keeps every pre-existing key unrestricted (all three columns nullable)", async () => {
    const { driver, keys } = await load();
    const created = await keys.createApiKey("legacy-buyer", "machine-1", { rpm: 5 });
    const readBack = await keys.getApiKeyById(created.id);

    expect(readBack.allowedIps).toBeNull();
    expect(readBack.tokenBalance).toBeNull();
    // A key with no balance is still allowed to spend: the gate is opt-in.
    expect(readBack.tokensSpent ?? 0).toBe(0);
  });
});

describe("per-key policy round trip", () => {
  it("persists an IP allow-list and a prepaid balance", async () => {
    const { keys } = await load();
    const created = await keys.createApiKey("buyer-ip", "machine-1", {
      allowedIps: ["203.0.113.7", "10.0.0.0/8"],
      tokenBalance: 1000,
    });
    const readBack = await keys.getApiKeyById(created.id);

    expect(readBack.allowedIps).toEqual(["203.0.113.7", "10.0.0.0/8"]);
    expect(readBack.tokenBalance).toBe(1000);
  });

  it("debits only keys that carry a balance", async () => {
    const { keys } = await load();
    const unlimited = await keys.createApiKey("unlimited", "machine-1", {});
    const prepaid = await keys.createApiKey("prepaid", "machine-1", { tokenBalance: 100 });

    await keys.addApiKeyTokensSpent(unlimited.id, 50);
    await keys.addApiKeyTokensSpent(prepaid.id, 50);

    // The zero-write path for ordinary keys is the point: their row is untouched.
    expect((await keys.getApiKeyById(unlimited.id)).tokensSpent ?? 0).toBe(0);
    expect((await keys.getApiKeyById(prepaid.id)).tokensSpent).toBe(50);
  });

  it("clears the gate when the balance is set to null", async () => {
    const { keys, usage } = await load();
    const key = await keys.createApiKey("cleared", "machine-1", { tokenBalance: 10 });
    await keys.addApiKeyTokensSpent(key.id, 10);

    const info = await keys.validateApiKey(key.key);
    expect(usage.checkApiKeyLimits(info, 1).allowed).toBe(false);

    await keys.setApiKeyBalance(key.id, null);
    const reopened = await keys.validateApiKey(key.key);
    expect(reopened.tokenBalance).toBeNull();
    expect(usage.checkApiKeyLimits(reopened, 1).allowed).toBe(true);
  });
});

describe("prepaid balance gates dispatch", () => {
  it("refuses once the balance is spent, and refuses a request that would overrun it", async () => {
    const { keys, usage } = await load();
    const key = await keys.createApiKey("metered", "machine-1", { tokenBalance: 100 });
    const info = await keys.validateApiKey(key.key);

    expect(usage.checkApiKeyLimits(info, 40).allowed).toBe(true);

    await keys.addApiKeyTokensSpent(key.id, 100);
    const spent = await keys.validateApiKey(key.key);
    const blocked = usage.checkApiKeyLimits(spent, 1);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/Prepaid token balance exhausted: 100\/100/);

    // 99 of 100 spent: a 5-token request is refused, a 1-token request is not.
    await keys.setApiKeyBalance(key.id, 100);
    const partial = await keys.createApiKey("partial", "machine-1", { tokenBalance: 100 });
    await keys.addApiKeyTokensSpent(partial.id, 99);
    const partialInfo = await keys.validateApiKey(partial.key);
    const tooBig = usage.checkApiKeyLimits(partialInfo, 5);
    expect(tooBig.allowed).toBe(false);
    expect(tooBig.reason).toMatch(/too low for this request: 1 of 100 tokens left/);
    expect(usage.checkApiKeyLimits(partialInfo, 1).allowed).toBe(true);
  });
});

describe("redeem codes", () => {
  it("mints unambiguous codes: unique, XXXX-XXXX-XXXX, no 0/O/1/I", async () => {
    const { redeem } = await load();
    const codes = await redeem.createRedeemCodes({
      quantity: 25,
      batchName: "batch-a",
      tokenValue: 500,
      extendsDays: 30,
    });

    expect(codes).toHaveLength(25);
    const values = codes.map((c) => c.code);
    expect(new Set(values).size).toBe(25);
    for (const value of values) {
      expect(value).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(value).not.toMatch(/[0O1I]/);
    }
  });

  it("turns one code into one fresh key carrying the code's quota and validity", async () => {
    const { keys, redeem } = await load();
    const [code] = await redeem.createRedeemCodes({
      quantity: 1,
      tokenValue: 5_000_000,
      extendsDays: 30,
      maxUses: 1,
    });

    const result = await redeem.redeemCode(code.code, { ip: "203.0.113.9" });
    expect(result.ok).toBe(true);
    expect(result.tokens).toBe(5_000_000);
    expect(result.days).toBe(30);
    expect(result.usesRemaining).toBe(0);

    // The issued key is a real key: it authenticates, and it carries the quota.
    expect(result.key.key).toMatch(/^sk-/);
    expect(await keys.validateApiKey(result.key.key)).not.toBeNull();
    const stored = await keys.getApiKeyById(result.key.id);
    expect(stored.tokenBalance).toBe(5_000_000);
    expect(stored.tokensSpent ?? 0).toBe(0);

    const days = (new Date(result.key.expiresAt).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    // Redemption always mints, never reuses a key.
    const [other] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 10 });
    expect((await redeem.redeemCode(other.code)).key.key).not.toBe(result.key.key);
  });

  it("accepts a hand-pasted code regardless of case or stray whitespace, and burns it", async () => {
    const { redeem } = await load();
    const [code] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 100, maxUses: 1 });

    const first = await redeem.redeemCode(`  ${code.code.toLowerCase()} `);
    expect(first.ok).toBe(true);

    const again = await redeem.redeemCode(code.code);
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already been used/);
  });

  it("honours maxUses and reports the remaining count", async () => {
    const { redeem } = await load();
    const [code] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 10, maxUses: 2 });

    expect((await redeem.redeemCode(code.code)).usesRemaining).toBe(1);
    expect((await redeem.redeemCode(code.code)).usesRemaining).toBe(0);
    const third = await redeem.redeemCode(code.code);
    expect(third.ok).toBe(false);
    expect(third.error).toMatch(/already been used/);
  });

  it("refuses unknown, revoked and expired codes", async () => {
    const { redeem } = await load();

    expect((await redeem.redeemCode("AAAA-BBBB-CCCC")).error).toMatch(/Unknown redeem code/);

    const [revoked] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 10 });
    await redeem.revokeRedeemCode(revoked.id);
    expect((await redeem.redeemCode(revoked.code)).error).toMatch(/revoked/);

    const [expired] = await redeem.createRedeemCodes({
      quantity: 1,
      tokenValue: 10,
      expiresAt: new Date(Date.now() - 86400000).toISOString(),
    });
    expect((await redeem.redeemCode(expired.code)).error).toMatch(/expired/);
  });

  it("treats an omitted quota or validity as unlimited, not as zero", async () => {
    const { keys, redeem } = await load();

    const [quotaOnly] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 1_000_000 });
    const a = await redeem.redeemCode(quotaOnly.code);
    expect((await keys.getApiKeyById(a.key.id)).tokenBalance).toBe(1_000_000);
    expect(a.key.expiresAt).toBeNull();

    const [daysOnly] = await redeem.createRedeemCodes({ quantity: 1, extendsDays: 7 });
    const b = await redeem.redeemCode(daysOnly.code);
    expect((await keys.getApiKeyById(b.key.id)).tokenBalance).toBeNull();
    const days = (new Date(b.key.expiresAt).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("names the issued key from the buyer, the batch, or a plain default", async () => {
    const { redeem } = await load();

    const [named] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 10 });
    expect((await redeem.redeemCode(named.code, { name: "budi" })).key.name).toBe("budi");

    const [batched] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 10, batchName: "batch-z" });
    expect((await redeem.redeemCode(batched.code)).key.name).toBe("batch-z");

    const [plain] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 10 });
    expect((await redeem.redeemCode(plain.code)).key.name).toBe("buyer");
  });

  it("lists and summarises a batch", async () => {
    const { redeem } = await load();
    const batch = await redeem.createRedeemCodes({ quantity: 4, batchName: "batch-b", tokenValue: 50 });
    await redeem.redeemCode(batch[0].code, { ip: "198.51.100.4" });
    await redeem.revokeRedeemCode(batch[1].id);

    const listed = await redeem.getRedeemCodes({ batchName: "batch-b" });
    expect(listed).toHaveLength(4);

    const active = await redeem.getRedeemCodes({ batchName: "batch-b", includeRevoked: false });
    expect(active.map((c) => c.id)).not.toContain(batch[1].id);
  });
});

// The IP binding is the part that has to be right: a key sold as "works from
// your server only" is worthless if the check is cosmetic, and a broken check
// would lock a buyer out of a key they paid for.
const req = (headers = {}) => new Request("http://local/v1/chat/completions", { headers });

describe("IP binding", () => {
  it("reads the client address from the proxy headers, left-most first", async () => {
    const { clientIp } = await import("@/sse/services/auth.js");

    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(req({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(req({ "cf-connecting-ip": "198.51.100.9" }))).toBe("198.51.100.9");
    // x-forwarded-for wins when both are present: it is the one the proxy chain
    // appends to.
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.4" }))).toBe("203.0.113.7");
    // The bundled launcher's socket-derived value beats every client-supplied
    // header, so a caller cannot pick its own source address when it is present.
    expect(clientIp(req({ "x-9r-real-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.9");
    // v4-mapped v6 and port/bracket noise normalize to the plain address.
    expect(clientIp(req({ "x-forwarded-for": "::ffff:203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7:51234" }))).toBe("203.0.113.7");
    expect(clientIp(req({ "x-forwarded-for": "[2001:db8::1]:443" }))).toBe("2001:db8::1");
    expect(clientIp(req({}))).toBeNull();
  });

  it("allows any source when no list is set, and none when the list is empty", async () => {
    const { isIpAllowed } = await import("@/sse/services/auth.js");

    expect(isIpAllowed({ allowedIps: null }, "203.0.113.7")).toBe(true);
    expect(isIpAllowed({ allowedIps: undefined }, null)).toBe(true);
    // An empty list is not "no policy" — it is "nothing allowed".
    expect(isIpAllowed({ allowedIps: [] }, "203.0.113.7")).toBe(false);
    // No address at all cannot satisfy a list that exists.
    expect(isIpAllowed({ allowedIps: ["203.0.113.7"] }, null)).toBe(false);
  });

  it("matches exact addresses and CIDR blocks", async () => {
    const { isIpAllowed } = await import("@/sse/services/auth.js");

    expect(isIpAllowed({ allowedIps: ["203.0.113.7"] }, "203.0.113.7")).toBe(true);
    expect(isIpAllowed({ allowedIps: ["203.0.113.7"] }, "203.0.113.8")).toBe(false);
    expect(isIpAllowed({ allowedIps: ["10.0.0.0/8"] }, "10.5.6.7")).toBe(true);
    expect(isIpAllowed({ allowedIps: ["10.0.0.0/8"] }, "11.5.6.7")).toBe(false);
    expect(isIpAllowed({ allowedIps: ["203.0.113.0/24"] }, "203.0.113.200")).toBe(true);
    expect(isIpAllowed({ allowedIps: ["0.0.0.0/0"] }, "8.8.8.8")).toBe(true);
    // Junk entries are skipped, not treated as a match.
    expect(isIpAllowed({ allowedIps: ["not-an-ip", ""] }, "203.0.113.7")).toBe(false);
    expect(isIpAllowed({ allowedIps: ["10.0.0.0/99"] }, "10.0.0.1")).toBe(false);
  });

  it("makes a bound key unusable from the wrong address", async () => {
    const { keys } = await load();
    const { isValidApiKey, resolveApiKeyIgnoringIp } = await import("@/sse/services/auth.js");

    const created = await keys.createApiKey("bound", "machine-1", { allowedIps: ["203.0.113.7"] });

    expect(await isValidApiKey(created.key, req({ "x-forwarded-for": "203.0.113.7" }))).not.toBeNull();
    expect(await isValidApiKey(created.key, req({ "x-forwarded-for": "198.51.100.4" }))).toBeNull();
    // And with no address to check at all, a bound key stays shut.
    expect(await isValidApiKey(created.key, req({}))).toBeNull();

    // The chat path needs to tell "bound elsewhere" from "dead" so it can answer
    // 403 instead of quietly serving the caller anonymously.
    expect(await resolveApiKeyIgnoringIp(created.key)).not.toBeNull();

    // An unbound key is unaffected: every address still works.
    const open = await keys.createApiKey("open", "machine-1", {});
    expect(await isValidApiKey(open.key, req({ "x-forwarded-for": "198.51.100.4" }))).not.toBeNull();
    expect(await isValidApiKey(open.key, req({}))).not.toBeNull();
  });
});

// The per-key traffic view is what a seller opens when a buyer asks "why is my
// key slow?". It must find a key's requests without the observability table
// keeping the key itself in plaintext — a sold key sitting readable in the DB is
// a spendable key.
describe("per-key traffic is attributable without storing the key", () => {
  const push = async (details, apiKey, n) => {
    for (let i = 0; i < n; i += 1) {
      await details.saveRequestDetail({
        id: `d${i}`,
        provider: "p",
        model: "m",
        apiKey,
        apiKeyName: "sold",
        timestamp: new Date(Date.now() + i).toISOString(),
        status: "success",
      });
    }
    // The writer batches (batchSize rows or flushIntervalMs); 20 pushes trip the
    // batch threshold, the tick lets the flush land.
    await new Promise((r) => setTimeout(r, 100));
  };

  it("writes the mask, never the plaintext, and still finds the rows", async () => {
    const { driver, details, mask } = await load();
    await driver.getAdapter();

    const raw = "fixture-resale-key-0123456789abcdef";
    await push(details, raw, 20);

    const db = await driver.getAdapter();
    const masked = mask.maskApiKey(raw);
    expect(db.get(`SELECT COUNT(*) as c FROM requestDetails`).c).toBe(20);
    expect(db.get(`SELECT COUNT(*) as c FROM requestDetails WHERE apiKey = ?`, [raw]).c).toBe(0);
    expect(db.get(`SELECT COUNT(*) as c FROM requestDetails WHERE apiKey = ?`, [masked]).c).toBe(20);
    // The JSON blob the dashboard renders is the same story.
    expect(db.get(`SELECT COUNT(*) as c FROM requestDetails WHERE data LIKE ?`, [`%${raw}%`]).c).toBe(0);

    // Both spellings resolve to the same key's traffic.
    const stats = await details.getRequestStatsForApiKey([masked, raw]);
    expect(stats.requests).toBe(20);
    const page = await details.getRequestDetails({ apiKeyAny: [masked, raw] });
    expect(page.pagination.totalItems).toBe(20);
    expect(page.details[0].apiKeyName).toBe("sold");
  });

  it("keeps rows written before the mask (plaintext) visible to the same filter", async () => {
    const { driver, details, mask } = await load();
    await driver.getAdapter();

    const raw = "fixture-resale-key-0123456789abcdef";
    const db = await driver.getAdapter();
    db.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, apiKey, apiKeyName, status, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      ["legacy", new Date().toISOString(), "p", "m", raw, "sold", "success", JSON.stringify({ id: "legacy", apiKey: raw })]
    );

    const stats = await details.getRequestStatsForApiKey([mask.maskApiKey(raw), raw]);
    expect(stats.requests).toBe(1);
    const page = await details.getRequestDetails({ apiKeyAny: [mask.maskApiKey(raw), raw] });
    expect(page.pagination.totalItems).toBe(1);
  });
});

// ── The whole quota surface, not just the token total (migration 011) ────────
// A code is a product. Before this, a code could only say "N tokens, M days";
// a seller selling "2jt token, 60 request per menit, 3 barengan" had no way to
// say it, and the buyer's key came out with no rate limits at all.
describe("a code carries the key's whole policy", () => {
  it("lands the limits column and stamps the new schema version", async () => {
    const { driver, migrations } = await load();
    const db = await driver.getAdapter();

    const columns = db.all(`PRAGMA table_info(redeemCodes)`).map((c) => c.name);
    expect(columns).toContain("limits");

    const stamped = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(stamped.value, 10)).toBe(migrations.latestVersion());
  });

  it("hands the buyer's key every axis the code named", async () => {
    const { keys, redeem } = await load();
    const [code] = await redeem.createRedeemCodes({
      quantity: 1,
      batchName: "full-quota",
      tokenValue: 2_000_000,
      extendsDays: 30,
      limits: { rpm: 2, rateLimitTpm: 20_000, rateLimitConcurrency: 1, maxTokensDaily: 500_000 },
    });

    // The blob survives the row round trip, so the seller sees what they sold.
    const listed = await redeem.getRedeemCodes({ batchName: "full-quota" });
    expect(listed[0].limits).toMatchObject({
      rpm: 2,
      rateLimitTpm: 20_000,
      rateLimitConcurrency: 1,
      maxTokensDaily: 500_000,
    });

    const result = await redeem.redeemCode(code.code);
    expect(result.ok).toBe(true);

    const info = await keys.validateApiKey(result.key.key);
    expect(info.tokenBalance).toBe(2_000_000);
    expect(info.rpm).toBe(2);
    expect(info.rateLimitTpm).toBe(20_000);
    expect(info.rateLimitConcurrency).toBe(1);
    expect(info.maxTokensDaily).toBe(500_000);

    // The buyer-facing slice is quota only — never provider or ACL policy.
    expect(result.limits).toMatchObject({ rpm: 2, rateLimitTpm: 20_000 });
    expect(result.limits).not.toHaveProperty("allowedProviders");
    expect(result.limits).not.toHaveProperty("allowedCombos");
  });

  it("enforces the axes on the issued key: the rate limit really bites", async () => {
    const { keys, redeem, usage } = await load();
    const [code] = await redeem.createRedeemCodes({ quantity: 1, limits: { rpm: 2 } });
    const result = await redeem.redeemCode(code.code);
    const info = await keys.validateApiKey(result.key.key);

    expect(usage.checkApiKeyLimits(info, 0).allowed).toBe(true);
    usage.recordApiKeyUsage(info, 0);
    expect(usage.checkApiKeyLimits(info, 0).allowed).toBe(true);
    usage.recordApiKeyUsage(info, 0);

    const third = usage.checkApiKeyLimits(info, 0);
    expect(third.allowed).toBe(false);
    expect(third.reason).toMatch(/requests per minute/);
  });

  it("lets tokenValue win over a conflicting limits.tokenBalance", async () => {
    const { keys, redeem } = await load();
    const [code] = await redeem.createRedeemCodes({
      quantity: 1,
      tokenValue: 1000,
      limits: { tokenBalance: 999_999, rpm: 5 },
    });
    const result = await redeem.redeemCode(code.code);
    const info = await keys.validateApiKey(result.key.key);

    expect(info.tokenBalance).toBe(1000);
    expect(info.rpm).toBe(5);
  });

  it("reads an axis the seller left blank as unlimited, not as zero", async () => {
    const { keys, redeem } = await load();
    const [code] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 500, limits: { rpm: 10 } });
    const result = await redeem.redeemCode(code.code);
    const info = await keys.validateApiKey(result.key.key);

    expect(info.rateLimitTpm).toBeNull();
    expect(info.tokens5h).toBeNull();
    expect(info.rateLimitConcurrency).toBeNull();
  });

  it("refuses a code that would carry nothing at all", async () => {
    const { redeem } = await load();
    await expect(redeem.createRedeemCodes({ quantity: 1 })).rejects.toThrow(/tokenValue, extendsDays, or limits/);
  });

  it("keeps a pre-011 code working: tokenValue alone, no policy blob", async () => {
    const { keys, redeem } = await load();
    const [code] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 700, extendsDays: 7 });
    expect(code.limits).toBeNull();

    const result = await redeem.redeemCode(code.code);
    const info = await keys.validateApiKey(result.key.key);
    expect(info.tokenBalance).toBe(700);
    expect(info.rpm).toBeNull();
  });

  it("drops unknown axes rather than writing a column that does not exist", async () => {
    const { redeem } = await load();
    const [code] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 100, limits: { rpm: 10, nonsense: 5 } });
    expect(code.limits.rpm).toBe(10);
    expect(Object.keys(code.limits)).not.toContain("nonsense");
  });
});
