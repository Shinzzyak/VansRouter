// The Compression tab of /dashboard/usage reads GET /api/analytics/compression.
//
// That route drains an in-process sink and folds the events into the kv
// aggregates. Until this test existed the sink had NO producer anywhere in the
// tree — `recordCompressionEvent` was exported, imported by nobody, and the tab
// therefore read a permanent zero no matter how much traffic the router served.
// The dashboard was not broken; it was faithfully reporting a pipeline with one
// end missing.
//
// Two separate things have to hold, so this pins both:
//
//   1. the chat path actually records an event (asserted on the source, because
//      the call site is module-private and reaching it needs a live upstream), and
//   2. an event survives sink -> drain -> fold -> summary through the REAL route,
//      so a request count on the dashboard means requests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let GET;
let recordCompressionEvent;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-compression-analytics-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  const dbApi = await import("@/lib/db/index.js");
  await dbApi.initDb();
  ({ recordCompressionEvent } = await import("open-sse/rtk/analytics.js"));
  ({ GET } = await import("@/app/api/analytics/compression/route.js"));
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// The route is dashboard-authenticated; the CLI token is the machine-derived one,
// so the test does not need to mint a session cookie or flip requireLogin.
async function callRoute(since = "24h") {
  const { getConsistentMachineId } = await import("@/shared/utils/machineId.js");
  const res = await GET(new Request(`http://localhost/api/analytics/compression?since=${since}`, {
    headers: { "x-9r-cli-token": await getConsistentMachineId("9r-cli-auth") },
  }));
  return { status: res.status, body: await res.json() };
}

describe("compression analytics pipeline", () => {
  it("records a saver event and surfaces it through the dashboard route", async () => {
    recordCompressionEvent({
      mode: "rtk",
      provider: "anthropic",
      model: "claude-x",
      originalTokens: 4000,
      tokensSaved: 1500,
    });

    const { status, body } = await callRoute("24h");

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.totalRequests).toBe(1);
    expect(body.totalTokensSaved).toBe(1500);
    expect(body.originalTokens).toBe(4000);
    expect(body.byMode.rtk.count).toBe(1);
    // A request that saved nothing is still a request the saver looked at.
    expect(body.bySkipReason).toEqual({});
    expect(body.last24h).toHaveLength(1);
    expect(body.topSavers).toHaveLength(1);
    expect(body.topSavers[0].savingsPct).toBeCloseTo(37.5, 1);
  });

  it("counts a skip as a request, with its reason", async () => {
    recordCompressionEvent({ mode: "none", provider: "openai", model: "gpt-x", skipped: true, skipReason: "no-tool-results" });

    const { body } = await callRoute("24h");

    expect(body.totalRequests).toBe(1);
    expect(body.totalSkipped).toBe(1);
    expect(body.totalTokensSaved).toBe(0);
    expect(body.bySkipReason).toEqual({ "no-tool-results": 1 });
    expect(body.byMode.none.count).toBe(1);
  });

  it("drains on read, so a second call does not double-count", async () => {
    recordCompressionEvent({ mode: "rtk", provider: "openai", model: "gpt-x", originalTokens: 800, tokensSaved: 400 });

    const first = await callRoute("24h");
    const second = await callRoute("24h");

    expect(first.body.totalRequests).toBe(1);
    expect(second.body.totalRequests).toBe(1);
    expect(second.body.totalTokensSaved).toBe(400);
  });

  it("honours the `since` window on the totals while the dimensions stay all-time", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600e3).toISOString();
    recordCompressionEvent({ mode: "rtk", provider: "openai", model: "gpt-x", originalTokens: 800, tokensSaved: 400, timestamp: threeDaysAgo });

    const { body } = await callRoute("24h");

    expect(body.totalRequests).toBe(0);
    expect(body.last24h).toHaveLength(0);
    // byMode is a flat counter, so it cannot be windowed — the response says so
    // in dimensionScope rather than pretending the window applies to it.
    expect(body.dimensionScope).toBe("all-time");
    expect(body.byMode.rtk.count).toBe(1);
  });
});

describe("compression analytics producer", () => {
  it("chatCore records a saver event on the request path", () => {
    const src = fs.readFileSync(new URL("../../open-sse/handlers/chatCore.js", import.meta.url), "utf8");

    // Importing the sink is not enough — the call has to exist.
    expect(src).toContain('from "../rtk/analytics.js"');
    expect(src).toMatch(/recordSaverEvent\(\{/);
    // One event per request, not one per saver pass.
    expect(src.match(/recordCompressionEvent\(/g)).toHaveLength(1);
  });
});
