// End-to-end cover for the nested-map write contract through the REAL route.
//
// Drives the REAL PATCH /api/settings route handler against a REAL SQLite DB
// in a temp DATA_DIR, then reads the raw row back. Proves the write path the
// dashboard uses, not just the helper.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let dbApi;
let db;
let PATCH;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-e2e-settings-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  dbApi = await import("@/lib/db/index.js");
  await dbApi.initDb();
  db = (await import("@/lib/db/driver.js")).getAdapterSync();
  ({ PATCH } = await import("@/app/api/settings/route.js"));
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const patch = async (body) => {
  const res = await PATCH(new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() };
};

const rawRow = () => JSON.parse(db.get(`SELECT data FROM settings WHERE id = 1`).data);

describe("E2E: PATCH /api/settings nested-map write contract", () => {
  it("a role-adapter save does NOT wipe the other adapter pools (the reported bug)", async () => {
    // Seed the pools the way the dashboard would.
    await patch({ capacityAdapter: {
      vision: { enabled: true, roundRobin: false, models: ["ag/gemini-3.5-flash"] },
      thinking: { enabled: true, roundRobin: false, models: ["ac/glm-5.2"] },
      execution: { enabled: true, roundRobin: false, models: ["smart-fallback"] },
      compact: { enabled: true, roundRobin: true, models: ["cbai/deepseek-v4.1-flash"] },
    } });

    // Now the exact shape the Vision card sends: whole map, one key edited.
    // (The page always sends all ALL_ADAPTER_KEYS, but a caller that knows only
    // one key must still not nuke the rest.)
    await patch({ capacityAdapter: {
      vision: { enabled: false, roundRobin: false, models: ["ag/gemini-3.5-flash"] },
    } });

    const row = rawRow();
    expect(row.capacityAdapter.vision.enabled).toBe(false);
    expect(row.capacityAdapter.thinking).toEqual({ enabled: true, roundRobin: false, models: ["ac/glm-5.2"] });
    expect(row.capacityAdapter.execution).toEqual({ enabled: true, roundRobin: false, models: ["smart-fallback"] });
    expect(row.capacityAdapter.compact).toEqual({ enabled: true, roundRobin: true, models: ["cbai/deepseek-v4.1-flash"] });

    // And getSettings() must report them still enabled.
    const s = await dbApi.getSettings();
    expect(s.capacityAdapter.thinking.enabled).toBe(true);
    expect(s.capacityAdapter.execution.enabled).toBe(true);
    expect(s.capacityAdapter.compact.enabled).toBe(true);
  });

  it("a field-level partial patch keeps the sibling fields of the same pool", async () => {
    await patch({ capacityAdapter: { compact: { enabled: true, roundRobin: true, models: ["a", "b"] } } });
    await patch({ capacityAdapter: { compact: { enabled: false } } });

    const entry = rawRow().capacityAdapter.compact;
    expect(entry.enabled).toBe(false);
    expect(entry.roundRobin).toBe(true);
    expect(entry.models).toEqual(["a", "b"]);
  });

  it("clearing a pool's models[] still works (arrays replace, never merge)", async () => {
    await patch({ capacityAdapter: { execution: { enabled: true, roundRobin: false, models: ["a", "b"] } } });
    await patch({ capacityAdapter: { execution: { models: [] } } });

    const entry = rawRow().capacityAdapter.execution;
    expect(entry.models).toEqual([]);
    expect(entry.enabled).toBe(true);
  });

  it("the exact payload the Combos page sends does not drop pdf/videoInput", async () => {
    // ALL_ADAPTER_KEYS in the Combos page = CAPACITY_ADAPTER_CAPS
    // (vision, audioInput) + ROLE_ADAPTER_CAPS (thinking, execution, compact).
    // pdf and videoInput are hidden from the UI but still exist in the stored
    // shape — so the page's whole-map PATCH omitted them on every save, which is
    // how the live row lost both keys.
    await patch({ capacityAdapter: {
      pdf: { enabled: true, roundRobin: false, models: ["some/pdf-model"] },
      videoInput: { enabled: true, roundRobin: false, models: ["some/video-model"] },
    } });

    // UI-shaped save: only the 5 keys the page knows about.
    await patch({ capacityAdapter: {
      vision: { enabled: true, roundRobin: false, models: ["ag/gemini-3.5-flash"] },
      audioInput: { enabled: false, roundRobin: false, models: [] },
      thinking: { enabled: false, roundRobin: false, models: [] },
      execution: { enabled: false, roundRobin: false, models: [] },
      compact: { enabled: false, roundRobin: true, models: ["cbai/deepseek-v4.1-flash"] },
    } });

    const row = rawRow();
    expect(row.capacityAdapter.pdf).toEqual({ enabled: true, roundRobin: false, models: ["some/pdf-model"] });
    expect(row.capacityAdapter.videoInput).toEqual({ enabled: true, roundRobin: false, models: ["some/video-model"] });
  });

  it("comboStrategies still deletes on omission — combo config is untouched by this fix", async () => {
    await patch({ comboStrategies: { round: { fallbackStrategy: "round-robin" }, round1: { fallbackStrategy: "fusion" } } });
    expect(Object.keys(rawRow().comboStrategies).sort()).toEqual(["round", "round1"]);

    // The media combo page: toggle round-robin off -> entry removed -> whole map PATCHed.
    await patch({ comboStrategies: { round: { fallbackStrategy: "round-robin" } } });
    expect(Object.keys(rawRow().comboStrategies)).toEqual(["round"]);
  });

  it("providerStrategies still deletes on omission", async () => {
    await patch({ providerStrategies: { ah: { rotateStrategy: "round-robin" }, gr: { rotateStrategy: "none" } } });
    await patch({ providerStrategies: { ah: { rotateStrategy: "round-robin" } } });
    expect(Object.keys(rawRow().providerStrategies)).toEqual(["ah"]);
  });

  it("a PATCH that does not mention capacityAdapter leaves it byte-identical", async () => {
    await patch({ capacityAdapter: { compact: { enabled: true, roundRobin: false, models: ["x"] } } });
    const before = JSON.stringify(rawRow().capacityAdapter);
    await patch({ rtkEnabled: true });
    expect(JSON.stringify(rawRow().capacityAdapter)).toBe(before);
  });
});
