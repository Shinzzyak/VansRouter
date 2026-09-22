// Locks the write contract for the three nested settings maps.
//
// Two different contracts live in these three maps, and conflating them is a
// real defect in both directions:
//
//   providerStrategies / comboStrategies — the dashboard reads the whole map,
//   edits it locally, and PATCHes the WHOLE map back. "Remove this entry" is
//   expressed by OMITTING the key. Absence in the payload therefore MUST mean
//   delete, or the operator can never switch a per-provider/per-combo override
//   back to the default.
//
//   capacityAdapter — no caller deletes an adapter key, but a writer that does
//   not know about a key (older dashboard build, out-of-repo client, a script)
//   sends the map without it. Absence there must NOT delete: a dropped role
//   adapter (compact/thinking/execution) silently returns as disabled, because
//   mergeWithDefaults() can only refill sub-keys that exist in DEFAULT_SETTINGS
//   and those three are not in it. The user-visible symptom is "I set Compact
//   and it keeps switching itself off".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let dbApi;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-map-contract-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  dbApi = await import("@/lib/db/index.js");
  await dbApi.initDb();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("providerStrategies — absence in a full-map PATCH means delete", () => {
  it("drops the entry the caller omitted", async () => {
    await dbApi.updateSettings({
      providerStrategies: { ah: { rotateStrategy: "round-robin" }, gr: { rotateStrategy: "none" } },
    });
    // Operator set `gr` back to default: the UI deletes the key and sends the rest.
    await dbApi.updateSettings({ providerStrategies: { ah: { rotateStrategy: "round-robin" } } });

    const settings = await dbApi.getSettings();
    expect(Object.keys(settings.providerStrategies).sort()).toEqual(["ah"]);
  });
});

describe("comboStrategies — absence in a full-map PATCH means delete", () => {
  it("drops the entry the caller omitted", async () => {
    await dbApi.updateSettings({
      comboStrategies: {
        round: { fallbackStrategy: "round-robin" },
        round1: { fallbackStrategy: "round-robin" },
      },
    });
    await dbApi.updateSettings({ comboStrategies: { round: { fallbackStrategy: "round-robin" } } });

    const settings = await dbApi.getSettings();
    expect(Object.keys(settings.comboStrategies).sort()).toEqual(["round"]);
  });
});

describe("capacityAdapter — absence must NOT delete an adapter pool", () => {
  it("keeps a role adapter the writer did not mention", async () => {
    const compact = { enabled: true, roundRobin: true, models: ["cbai/deepseek-v4.1-flash"] };
    await dbApi.updateSettings({
      capacityAdapter: {
        vision: { enabled: true, roundRobin: false, models: ["ag/gemini-3.5-flash"] },
        compact,
      },
    });
    // A writer that only knows the capability adapters.
    await dbApi.updateSettings({
      capacityAdapter: { vision: { enabled: true, roundRobin: false, models: ["ag/gemini-3.5-flash"] } },
    });

    const settings = await dbApi.getSettings();
    expect(settings.capacityAdapter.compact).toEqual(compact);
  });

  it("still applies a field the writer did mention", async () => {
    await dbApi.updateSettings({
      capacityAdapter: { compact: { enabled: true, roundRobin: false, models: ["a/b"] } },
    });
    await dbApi.updateSettings({ capacityAdapter: { compact: { enabled: false } } });

    const settings = await dbApi.getSettings();
    expect(settings.capacityAdapter.compact.enabled).toBe(false);
    expect(settings.capacityAdapter.compact.models).toEqual(["a/b"]);
  });
});
