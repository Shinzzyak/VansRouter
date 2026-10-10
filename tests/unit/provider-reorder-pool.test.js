// Pool reorder invariants — proven against a REAL sqlite adapter, because the
// bug this pins lives in the database, not in the handler.
//
// A pool move is "swap two rows AND renumber 1..N". Done as a per-row priority
// PUT it cannot be atomic: the moved row gets the newest `updatedAt`, and the
// pool order breaks ties with `updatedAt DESC`, so the row that just moved
// sorts FIRST. A "move down" then reads back as "move up" — the UI shows the
// row snapping back and the API reports success. The only correct shape is one
// transaction that swaps and renumbers together.
//
// Second invariant: a NULL priority sorts LAST, never first. `ORDER BY
// priority ASC` alone puts NULLs first in SQLite, which promotes a row that
// was never ranked to the top of the pool — i.e. routes live traffic to the
// connection with no priority at all.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let repo;
let adapter;

const PROVIDER = "reorder-probe";

async function seed(names) {
  for (const name of names) {
    await repo.createProviderConnection({
      provider: PROVIDER,
      authType: "apikey",
      name,
      apiKey: "k-" + name,
      isActive: true,
    });
  }
}

const rows = () =>
  adapter.all(
    `SELECT id, name, priority, updatedAt FROM providerConnections WHERE provider = ?`,
    [PROVIDER],
  );

// Order the way the pool orderer does, so assertions match routing behaviour.
const liveOrder = () =>
  rows()
    .slice()
    .sort((a, b) => {
      const pa = a.priority === null || a.priority === undefined ? 999999 : a.priority;
      const pb = b.priority === null || b.priority === undefined ? 999999 : b.priority;
      if (pa !== pb) return pa - pb;
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    })
    .map((r) => r.name);

const idOf = (name) => rows().find((r) => r.name === name).id;

function assertHealthyPool() {
  const priorities = rows().map((r) => r.priority);
  expect(priorities.every((p) => Number.isInteger(p) && p >= 1)).toBe(true);
  expect(new Set(priorities).size).toBe(priorities.length);
  expect(priorities.slice().sort((a, b) => a - b)).toEqual(
    priorities.map((_, i) => i + 1),
  );
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-reorder-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  const driver = await import("@/lib/db/driver.js");
  adapter = await driver.getAdapter();
  repo = await import("@/lib/db/repos/connectionsRepo.js");
});

afterAll(() => {
  try {
    adapter?.close?.();
  } catch {}
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("pool reorder — one transaction, total order", () => {
  it("fresh rows land in creation order with contiguous priorities", async () => {
    await seed(["a", "b", "c"]);
    expect(liveOrder()).toEqual(["a", "b", "c"]);
    assertHealthyPool();
  });

  it("move up swaps with the row above and renumbers", async () => {
    const out = await repo.reorderProviderConnections(PROVIDER, idOf("c"), -1);
    expect(out.error).toBeUndefined();
    expect(liveOrder()).toEqual(["a", "c", "b"]);
    expect(out.order.map((id) => rows().find((r) => r.id === id).name)).toEqual(["a", "c", "b"]);
    assertHealthyPool();
  });

  it("move down swaps back — the moved row does not stick to the top", async () => {
    // Precondition asserted so this test cannot pass vacuously off the previous
    // one's state (a no-op swap would leave the pool already in "expected" order).
    expect(liveOrder()).toEqual(["a", "c", "b"]);
    await repo.reorderProviderConnections(PROVIDER, idOf("c"), 1);
    expect(liveOrder()).toEqual(["a", "b", "c"]);
    expect(liveOrder()[0]).not.toBe("c");
    assertHealthyPool();
  });

  it("moving the top row up is a no-op that still leaves a valid pool", async () => {
    await repo.reorderProviderConnections(PROVIDER, idOf("a"), -1);
    expect(liveOrder()).toEqual(["a", "b", "c"]);
    assertHealthyPool();
  });

  it("moving the bottom row down is a no-op that still leaves a valid pool", async () => {
    await repo.reorderProviderConnections(PROVIDER, idOf("c"), 1);
    expect(liveOrder()).toEqual(["a", "b", "c"]);
    assertHealthyPool();
  });

  it("a NULL priority is ranked LAST by the pool orderer, not first", async () => {
    // Assert against PRODUCTION ordering: set a NULL, then renumber and read
    // the priorities back. A test-local comparator would pass even if the SQL
    // put NULLs first — the negative control proved exactly that.
    adapter.run(`UPDATE providerConnections SET priority = NULL WHERE id = ?`, [idOf("a")]);
    const out = await repo.reorderProviderConnections(PROVIDER);
    expect(out.order[out.order.length - 1]).toBe(idOf("a"));
    expect(rows().find((r) => r.name === "a").priority).toBe(3);
    expect(liveOrder()).toEqual(["b", "c", "a"]);
    assertHealthyPool();
  });

  it("a plain renumber repairs duplicate priorities", async () => {
    const now = Date.now();
    adapter.run(`UPDATE providerConnections SET priority = 1, updatedAt = ? WHERE id = ?`, [
      new Date(now).toISOString(),
      idOf("b"),
    ]);
    adapter.run(`UPDATE providerConnections SET priority = 1, updatedAt = ? WHERE id = ?`, [
      new Date(now - 5000).toISOString(),
      idOf("c"),
    ]);
    const out = await repo.reorderProviderConnections(PROVIDER);
    expect(out.error).toBeUndefined();
    expect(liveOrder()).toEqual(["b", "c", "a"]);
    assertHealthyPool();
  });

  it("legacy duplicate priorities: the move is relative to the live order", async () => {
    // Two rows sharing priority 1 with distinct updatedAt — the state a
    // half-applied two-PUT swap leaves behind.
    const now = Date.now();
    adapter.run(`UPDATE providerConnections SET priority = 1, updatedAt = ? WHERE id = ?`, [
      new Date(now - 5000).toISOString(),
      idOf("b"),
    ]);
    adapter.run(`UPDATE providerConnections SET priority = 1, updatedAt = ? WHERE id = ?`, [
      new Date(now).toISOString(),
      idOf("c"),
    ]);
    const before = liveOrder();
    // Move whatever currently sits first DOWN; it must end up second.
    const first = before[0];
    await repo.reorderProviderConnections(PROVIDER, idOf(first), 1);
    expect(liveOrder()[0]).not.toBe(first);
    expect(liveOrder()[1]).toBe(first);
    assertHealthyPool();
  });

  it("an unknown connection id reports not_found and changes nothing", async () => {
    const before = rows().map((r) => `${r.id}:${r.priority}`);
    const out = await repo.reorderProviderConnections(PROVIDER, "no-such-id", -1);
    expect(out.error).toBe("not_found");
    expect(rows().map((r) => `${r.id}:${r.priority}`)).toEqual(before);
  });

  it("renumbering one provider never touches another provider's pool", async () => {
    await repo.createProviderConnection({
      provider: "other-probe",
      authType: "apikey",
      name: "z",
      apiKey: "k-z",
      isActive: true,
    });
    const otherBefore = adapter.all(
      `SELECT id, priority FROM providerConnections WHERE provider = 'other-probe'`,
    );
    await repo.reorderProviderConnections(PROVIDER, idOf("a"), -1);
    const otherAfter = adapter.all(
      `SELECT id, priority FROM providerConnections WHERE provider = 'other-probe'`,
    );
    expect(otherAfter).toEqual(otherBefore);
    assertHealthyPool();
  });
});
