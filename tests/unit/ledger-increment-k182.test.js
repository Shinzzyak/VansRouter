/**
 * K182 — the ledger must COUNT, not restart.
 *
 * Production symptom (2026-10-19): the chat path logged `recorded PATUH` on
 * every request, the state file's `savedAt` advanced, and the row never moved.
 * The log line that gave it away:
 *
 *   [ENGINE-LEDGER] inc key=skg/z-ai/glm-5.3-flash n=1 pat=1
 *
 * `n=1` after an increment means the entry it incremented had `n=0`, i.e. a
 * brand-new row — while the same key on disk read `n=2`. `resolveModel` returns
 * null whenever a bare id matches more than one provider, and the write path
 * then built a fresh `{n:0}` and `ledger.set()` it straight over the existing
 * row. Every request overwrote the evidence it had just recorded.
 *
 * These tests run the SHIPPED bundle, so a bundle that regresses fails here.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE = existsSync("data/engine/engine.cjs")
  ? "data/engine/engine.cjs"
  // The deploy pipeline DELETES the root bundle; the server loads the copy under
  // .next/standalone. Test whichever is present so the gate survives a deploy.
  : ".next/standalone/data/engine/engine.cjs";

let E = null;
let dataDir = null;

function loadBundle(dir) {
  const src = readFileSync(BUNDLE, "utf8");
  const m = { exports: {} };
  const req = (id) => process.getBuiltinModule(id.replace(/^node:/, ""));
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", "__filename", "__dirname", src)(
    m,
    m.exports,
    req,
    BUNDLE,
    process.cwd()
  );
  return m.exports;
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "k182-"));
  // Two providers share the bare id `glm-9.9-flash`, so a bare-id lookup is
  // ambiguous — exactly the shape that produced `found === null` in production.
  const seeded = {
    v: 1,
    savedAt: Date.now(),
    selfMeasuringBypass: [
      ["alpha/glm-9.9-flash", { n: 5, esc: 1, pat: 4, wins: { T2: 4 }, tries: { T2: 5 } }],
      ["beta/glm-9.9-flash", { n: 3, esc: 1, pat: 2, wins: { T2: 2 }, tries: { T2: 3 } }],
    ],
  };
  writeFileSync(join(dataDir, "engine-state.json"), JSON.stringify(seeded));
  process.env.DATA_DIR = dataDir;
  E = loadBundle(dataDir);
});

describe("K182 — ledger increments instead of resetting", () => {
  it("recordCompliant keeps counting when the bare id is ambiguous", () => {
    const smb = E.selfMeasuringBypass;
    expect(E.engineState.hydrate()).toBe(true);

    const key = "alpha/glm-9.9-flash";
    const before = smb.ledgerSnapshot(500).find((r) => r.model === key);
    expect(before.n).toBe(5);

    // Bare id + explicit route: the shape the chat path uses.
    smb.recordCompliant("glm-9.9-flash", "T2", key);
    const after = smb.ledgerSnapshot(500).find((r) => r.model === key);

    expect(after.n).toBe(6);
    expect(after.pat).toBe(5);
  });

  it("a second call keeps counting too (no per-request reset)", () => {
    const smb = E.selfMeasuringBypass;
    const key = "alpha/glm-9.9-flash";
    smb.recordCompliant("glm-9.9-flash", "T2", key);
    smb.recordCompliant("glm-9.9-flash", "T2", key);
    const row = smb.ledgerSnapshot(500).find((r) => r.model === key);
    expect(row.n).toBe(8);
    expect(row.pat).toBe(7);
  });

  it("the increment reaches the state file", async () => {
    const smb = E.selfMeasuringBypass;
    const key = "alpha/glm-9.9-flash";
    smb.recordCompliant("glm-9.9-flash", "T2", key);
    // The recording copy flushes its own section on a short debounce.
    const file = join(dataDir, "engine-state.json");
    const deadline = Date.now() + 4000;
    let row = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (!existsSync(file)) continue;
      const disk = JSON.parse(readFileSync(file, "utf8"));
      const rows = disk.selfMeasuringBypass || [];
      const found = rows.find((r) => r[0] === key);
      if (found && found[1].n >= 9) {
        row = found[1];
        break;
      }
    }
    expect(row, "state file never received the increment").not.toBeNull();
    expect(row.pat).toBeGreaterThanOrEqual(8);
  });
});
