/**
 * K183 — the state panel must be able to show a HEALTHY route.
 *
 * `ledgerSnapshot()` sorts by `n` (how many requests a model saw) and slices.
 * A route with `pat > 0` is one that just proved itself compliant, and those are
 * the rows with the SMALLEST `n` — they are new. So a 50-row window by `n`
 * systematically cut out exactly the rows `pat` exists to report: the file said
 * `pat 4` and the panel said `pat 0` for months of eyeballing.
 *
 * Two halves:
 *   1. behaviour — the window really does hide a low-`n` row, and a wide window
 *      really does include it (runs the SHIPPED bundle);
 *   2. wiring — the route asks for the wide window in both places it reads from
 *      (its own copy and the persisted file).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE = existsSync("data/engine/engine.cjs")
  ? "data/engine/engine.cjs"
  // The deploy pipeline DELETES the root bundle; the one the server actually
  // loads lives under .next/standalone. Tests must run against whichever is
  // present, or they pass locally and vanish after a deploy.
  : ".next/standalone/data/engine/engine.cjs";
const ROUTE = "src/app/api/engine/state/route.js";

let smb = null;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "k183-"));
  // 60 noisy models, all with high n — the shape that fills a 50-row window.
  const entries = [];
  for (let i = 0; i < 60; i += 1) {
    entries.push([`bulk/model-${i}`, { n: 1000 - i, esc: 0, pat: 0 }]);
  }
  // The healthy route: one request, one compliant answer. Lowest possible n.
  entries.push(["alpha/fresh-healthy", { n: 1, esc: 0, pat: 1 }]);
  writeFileSync(
    join(dir, "engine-state.json"),
    JSON.stringify({ v: 1, savedAt: Date.now(), selfMeasuringBypass: entries })
  );
  process.env.DATA_DIR = dir;

  const src = readFileSync(BUNDLE, "utf8");
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", "__filename", "__dirname", src)(
    m,
    m.exports,
    (id) => process.getBuiltinModule(id.replace(/^node:/, "")),
    BUNDLE,
    process.cwd()
  );
  m.exports.engineState.hydrate();
  smb = m.exports.selfMeasuringBypass;
});

describe("K183 — a healthy route survives the ledger window", () => {
  it("a 50-row window by n hides the low-n healthy row", () => {
    const narrow = smb.ledgerSnapshot(50).map((r) => r.model);
    expect(narrow).toHaveLength(50);
    expect(narrow).not.toContain("alpha/fresh-healthy");
  });

  it("the wide window includes it, with its pat visible", () => {
    const wide = smb.ledgerSnapshot(500);
    const row = wide.find((r) => r.model === "alpha/fresh-healthy");
    expect(row).toBeTruthy();
    expect(row.pat).toBe(1);
    expect(wide.length).toBeGreaterThan(50);
  });

  it("the route asks for the wide window in both reads", () => {
    const src = readFileSync(ROUTE, "utf8");
    // persisted read: the file is bounded by MAX_LEDGER, so send all of it
    expect(src).toMatch(/ledger:\s*rows,/);
    expect(src).not.toMatch(/ledger:\s*rows\.slice\(0,\s*50\)/);
    // per-instance read
    expect(src).toMatch(/ledgerSnapshot\(500\)/);
    expect(src).not.toMatch(/ledgerSnapshot\(50\)/);
  });
});
