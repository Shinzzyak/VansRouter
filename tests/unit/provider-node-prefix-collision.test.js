import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

/**
 * A provider node whose prefix is also a built-in registry alias is unreachable:
 * getModelInfo() skips the node lookup for reserved prefixes, so "<prefix>/<model>"
 * silently routes to the built-in provider instead of the node.
 * These tests pin both the detector and the create/update routes that use it.
 */

async function setupRoute() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-prefix-collision-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));

  const { POST } = await import("@/app/api/provider-nodes/route.js");
  const { PUT } = await import("@/app/api/provider-nodes/[id]/route.js");
  const { findReservedPrefixCollision } = await import("@/sse/services/model.js");
  return {
    POST,
    PUT,
    findReservedPrefixCollision,
    cleanup() { fs.rmSync(tempDir, { recursive: true, force: true }); },
  };
}

function makePost(body) {
  return new Request("https://9router.local/api/provider-nodes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePut(body) {
  return new Request("https://9router.local/api/provider-nodes/some-id", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const NODE = {
  type: "openai-compatible",
  apiType: "chat",
  name: "Collision Probe",
  baseUrl: "https://example.invalid/v1",
};

describe("provider node prefix collision", () => {
  let cleanup = () => {};

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("detects a prefix owned by a built-in provider and reports the owner", async () => {
    const ctx = await setupRoute();
    cleanup = ctx.cleanup;

    // "tr" is claimed by BOTH tokenrouter (aliases) and trae (alias). Routing is
    // last-write-wins, so "tr/..." reaches trae — the reported owner must match
    // the resolver, not merely flag a collision.
    const { resolveProviderAlias } = await import("open-sse/services/model.js");
    expect(ctx.findReservedPrefixCollision("tr")).toBe(resolveProviderAlias("tr"));
    expect(ctx.findReservedPrefixCollision("tr")).toBe("trae");
    expect(ctx.findReservedPrefixCollision("  tr  ")).toBe("trae");
    // provider ids are reserved as well as their aliases
    expect(ctx.findReservedPrefixCollision("trae")).toBe("trae");
  });

  it("returns null for a free prefix and for empty input", async () => {
    const ctx = await setupRoute();
    cleanup = ctx.cleanup;

    expect(ctx.findReservedPrefixCollision("tia")).toBeNull();
    expect(ctx.findReservedPrefixCollision("zzq")).toBeNull();
    expect(ctx.findReservedPrefixCollision("")).toBeNull();
    expect(ctx.findReservedPrefixCollision(undefined)).toBeNull();
  });

  it("POST refuses a colliding prefix with 409 and does not create the node", async () => {
    const ctx = await setupRoute();
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makePost({ ...NODE, prefix: "tr" }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("trae");
    expect(body.error).toContain("tr");

    const { getProviderNodes } = await import("@/models/index.js");
    expect(await getProviderNodes()).toHaveLength(0);
  });

  it("POST accepts a free prefix", async () => {
    const ctx = await setupRoute();
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makePost({ ...NODE, prefix: "tia" }));
    expect(response.status).toBe(201);
  });

  it("PUT refuses renaming a node onto a colliding prefix", async () => {
    const ctx = await setupRoute();
    cleanup = ctx.cleanup;

    const created = await ctx.POST(makePost({ ...NODE, prefix: "tia" }));
    expect(created.status).toBe(201);
    const { node } = await created.json();

    const response = await ctx.PUT(
      makePut({ ...NODE, prefix: "tr" }),
      { params: Promise.resolve({ id: node.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("trae");

    const { getProviderNodeById } = await import("@/models/index.js");
    const stored = await getProviderNodeById(node.id);
    expect(stored.prefix).toBe("tia");
  });

  it("PUT still allows an update that keeps a free prefix", async () => {
    const ctx = await setupRoute();
    cleanup = ctx.cleanup;

    const created = await ctx.POST(makePost({ ...NODE, prefix: "tia" }));
    const { node } = await created.json();

    const response = await ctx.PUT(
      makePut({ ...NODE, prefix: "tia", name: "Renamed" }),
      { params: Promise.resolve({ id: node.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.node.name).toBe("Renamed");
  });
});
