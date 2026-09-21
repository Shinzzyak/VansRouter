// Hardening tests for the models.dev catalog sync.
//
// Two real failure modes this covers:
//   1. A degenerate upstream payload (rollback, partial outage, shape change)
//      builds an EMPTY catalog. Writing it destroys the previous good file and
//      blanks every catalog-derived capability until the next successful sync.
//   2. The upstream response was read with response.json() — unbounded. It is a
//      third party and the body is ~4.3MB; a hostile or broken response could
//      grow without limit inside the server process.
//
// Plus the redirect/https posture on that same third-party fetch.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Point DATA_DIR at a throwaway dir BEFORE anything reads it. dataDir.js
// recognizes /tmp/9router-data-* as a smoke dir and only blocks those when the
// process looks production-like, which a test run is not.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "9router-data-catalog-"));
process.env.VANSROUTER_DATA_DIR = TMP;

const { CATALOG_FILE } = await import("open-sse/providers/catalogOverride.js");
const { syncModelCatalog, getSyncState } = await import("@/lib/modelCatalog/sync.js");

const GOOD_CATALOG = {
  v: 1,
  etag: "etag-good",
  syncedAt: 1_700_000_000_000,
  models: { "gpt-4o": { vision: true } },
  providers: { openai: { "gpt-4o": { contextWindow: 128000 } } },
};

// A models.dev-shaped payload that survives build() with a non-empty result.
const UPSTREAM_OK = {
  openai: {
    models: {
      "gpt-4o": {
        modalities: { input: ["text", "image"] },
        limit: { context: 128000, output: 16384 },
      },
    },
  },
};

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function readCatalogFile() {
  try {
    return JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeGoodCatalog() {
  fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true });
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(GOOD_CATALOG), "utf8");
}

beforeEach(() => {
  vi.unstubAllGlobals();
  writeGoodCatalog();
});

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("model catalog sync — hardening", () => {
  it("a degenerate upstream payload does NOT overwrite the previous good file", async () => {
    // Shape valid, content empty: exactly what an upstream rollback looks like.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));

    const result = await syncModelCatalog();

    expect(result).toBeNull();
    expect(getSyncState().lastError).toMatch(/0 models/);
    expect(readCatalogFile()).toEqual(GOOD_CATALOG); // untouched, not blanked
  });

  it("a partial upstream payload (no usable models) also keeps the previous file", async () => {
    // Provider present but every model lacks the fields build() needs.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ openai: { models: {} } })));

    const result = await syncModelCatalog();

    expect(result).toBeNull();
    expect(readCatalogFile()).toEqual(GOOD_CATALOG);
  });

  it("a healthy payload still writes (no regression on the normal path)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(UPSTREAM_OK, { headers: { etag: "etag-new" } })));

    const result = await syncModelCatalog();

    expect(result).not.toBeNull();
    expect(result.status).toBe("updated");
    expect(result.models).toBeGreaterThan(0);
    const written = readCatalogFile();
    expect(written.etag).toBe("etag-new");
    expect(Object.keys(written.models).length).toBeGreaterThan(0);
  });

  it("refuses to follow a redirect on the catalog fetch", async () => {
    const spy = vi.fn(async () => jsonResponse(UPSTREAM_OK));
    vi.stubGlobal("fetch", spy);

    await syncModelCatalog();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1].redirect).toBe("error");
  });

  it("rejects a response body larger than the cap instead of buffering it", async () => {
    // 13MB of valid JSON — over the 12MB cap. Built lazily so the test itself
    // does not hold the whole string.
    const filler = "x".repeat(1024 * 1024);
    const huge = () => {
      const parts = [];
      for (let i = 0; i < 13; i++) parts.push(filler);
      return parts.join("");
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(huge(), { status: 200 })));

    const result = await syncModelCatalog();

    expect(result).toBeNull();
    expect(getSyncState().lastError).toMatch(/over 12582912 bytes/);
    expect(readCatalogFile()).toEqual(GOOD_CATALOG); // previous file survives
  });

  it("a 304 keeps the previous file and reports unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));

    const result = await syncModelCatalog();

    expect(result).toEqual({ status: "unchanged" });
    expect(readCatalogFile()).toEqual(GOOD_CATALOG);
  });

  it("an HTTP error keeps the previous file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));

    const result = await syncModelCatalog();

    expect(result).toBeNull();
    expect(getSyncState().lastError).toMatch(/503/);
    expect(readCatalogFile()).toEqual(GOOD_CATALOG);
  });
});
