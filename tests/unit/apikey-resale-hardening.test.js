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

  it("credits the balance, extends expiry and burns exactly one use", async () => {
    const { keys, redeem } = await load();
    const key = await keys.createApiKey("buyer-redeem", "machine-1", { tokenBalance: 100 });
    const [code] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 500, extendsDays: 30, maxUses: 1 });

    const result = await redeem.redeemCode(code.code, { id: key.id });
    expect(result.ok).toBe(true);
    expect(result.creditedTokens).toBe(500);
    expect(result.tokenBalance).toBe(600);
    expect(result.usesRemaining).toBe(0);

    const days = (new Date(result.expiresAt).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    const after = await keys.getApiKeyById(key.id);
    expect(after.tokenBalance).toBe(600);

    // Lower case and stray whitespace still match: codes get pasted by hand.
    const again = await redeem.redeemCode(`  ${code.code.toLowerCase()} `, { id: key.id });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already been used/);
  });

  it("honours maxUses and reports the remaining count", async () => {
    const { keys, redeem } = await load();
    const key = await keys.createApiKey("buyer-multi", "machine-1", {});
    const [code] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 10, maxUses: 2 });

    expect((await redeem.redeemCode(code.code, { id: key.id })).usesRemaining).toBe(1);
    expect((await redeem.redeemCode(code.code, { id: key.id })).usesRemaining).toBe(0);
    const third = await redeem.redeemCode(code.code, { id: key.id });
    expect(third.ok).toBe(false);
    expect(third.error).toMatch(/already been used/);
  });

  it("refuses unknown, revoked and expired codes", async () => {
    const { keys, redeem } = await load();
    const key = await keys.createApiKey("buyer-bad", "machine-1", {});

    expect((await redeem.redeemCode("AAAA-BBBB-CCCC", { id: key.id })).error).toMatch(/Unknown redeem code/);

    const [revoked] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 10 });
    await redeem.revokeRedeemCode(revoked.id);
    expect((await redeem.redeemCode(revoked.code, { id: key.id })).error).toMatch(/revoked/);

    const [expired] = await redeem.createRedeemCodes({
      quantity: 1,
      tokenValue: 10,
      expiresAt: new Date(Date.now() - 86400000).toISOString(),
    });
    expect((await redeem.redeemCode(expired.code, { id: key.id })).error).toMatch(/expired/);
  });

  it("extends from now when the key is already expired, so no paid time is lost", async () => {
    const { keys, redeem } = await load();
    const key = await keys.createApiKey("buyer-late", "machine-1", {
      expiresAt: new Date(Date.now() - 10 * 86400000).toISOString(),
    });
    const [code] = await redeem.createRedeemCodes({ quantity: 1, extendsDays: 7 });

    const result = await redeem.redeemCode(code.code, { id: key.id });
    const days = (new Date(result.expiresAt).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    // The key is alive again: expiry is re-read on every auth.
    expect(await keys.validateApiKey(key.key)).not.toBeNull();
  });

  it("does not resurrect a key the admin switched off", async () => {
    const { keys, redeem } = await load();
    const key = await keys.createApiKey("buyer-off", "machine-1", {});
    await keys.toggleApiKey(key.id); // admin disables it (leak, chargeback, ...)
    const [code] = await redeem.createRedeemCodes({ quantity: 1, tokenValue: 100, extendsDays: 30 });

    const result = await redeem.redeemCode(code.code, { id: key.id });
    expect(result.ok).toBe(true);
    expect((await keys.getApiKeyById(key.id)).isActive).toBeFalsy();
    expect(await keys.validateApiKey(key.key)).toBeNull();
  });

  it("lists and summarises a batch", async () => {
    const { redeem } = await load();
    const batch = await redeem.createRedeemCodes({ quantity: 4, batchName: "batch-b", tokenValue: 50 });
    await redeem.redeemCode(batch[0].code, { id: (await (await load()).keys.createApiKey("x", "m", {})).id });
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

    const raw = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
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

    const raw = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
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
