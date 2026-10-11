/**
 * The zai sidecar's parking lot must outlive the process.
 *
 * Why this exists: `_cooldown`/`_fails` lived only in memory. The sidecar's
 * round-robin ALSO restarts at index 0 on every boot (`_rr = 0`), so the first
 * request after each restart was handed to `emails[0]` every single time. When
 * that seat was a dead account it burned the worker's whole turn deadline and
 * the client got 502 -- measured live 2026-10-11 23:5x at 254s wall, on the
 * same account (amy.murphy, pool index 0) the sidecar's own note records
 * burning 209s at 17:54. Cold start is NOT the cause: restarting the sidecar
 * against a healthy index 0 costs ~1.3s (26.8s cold vs 25.5s warm, both 200).
 *
 * This test runs REAL python in separate processes -- a fresh process is the
 * only honest way to test "survives a restart".
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const ZCODEREG = resolve(here, "../../scripts/python/zcodereg");

const dir = mkdtempSync(join(tmpdir(), "zaiguard-"));
const STATE = join(dir, "zai_guard.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run a snippet in a FRESH interpreter with the guard pointed at STATE. */
function fresh(snippet) {
  return execFileSync("python3", ["-c", snippet], {
    cwd: ZCODEREG,
    env: { ...process.env, ZAI_GUARD_STATE: STATE, PYTHONPATH: ZCODEREG },
    encoding: "utf8",
  }).trim();
}

const probe = (acct) => `
import json, zai_anti_ban as g
ok, why = g.allow_request("${acct}")
print(json.dumps({"ok": ok, "why": why, "fails": g.stats()["consecutive_fails"].get("${acct}", 0)}))
`;

const DEAD = "amy.murphy@e-mail.bty.web.id";
const ALIVE = "amy.williams@e-mail.bty.web.id";

describe("zai guard persistence (K96)", () => {
  it("parks a failing account, and the ticket survives a restart", () => {
    // Process 1: the account fails. It must be parked AND written to disk.
    const parked = JSON.parse(fresh(`
import json, zai_anti_ban as g
g.note_result("${DEAD}", False)
ok, why = g.allow_request("${DEAD}")
print(json.dumps({"ok": ok, "why": why, "state_on_disk": __import__("os").path.exists(g.STATE_PATH)}))
`));
    expect(parked.state_on_disk).toBe(true);
    expect(parked.ok).toBe(false);
    expect(parked.why).toMatch(/cooling down/);

    // Process 2: a FRESH interpreter. Before the fix this returned ok:true --
    // the restart wiped the parking lot and re-hired the dead account.
    const afterRestart = JSON.parse(fresh(probe(DEAD)));
    expect(afterRestart.ok).toBe(false);
    expect(afterRestart.why).toMatch(/cooling down/);
    expect(afterRestart.fails).toBeGreaterThan(0);

    // A healthy account is untouched -- persistence must not park the pool.
    expect(JSON.parse(fresh(probe(ALIVE))).ok).toBe(true);
  });

  it("CONTROL: without the state file the parking lot is gone", () => {
    // Proves the assertion above measures the FILE and not something else in
    // the interpreter. Same code, same account, no state file -> allowed.
    expect(existsSync(STATE)).toBe(true);
    const saved = readFileSync(STATE, "utf8");
    rmSync(STATE);
    expect(JSON.parse(fresh(probe(DEAD))).ok).toBe(true);
    writeFileSync(STATE, saved);
  });

  it("a success clears the ticket and the cleared state is written too", () => {
    const cleared = JSON.parse(fresh(`
import json, zai_anti_ban as g
g.note_result("${DEAD}", True)
ok, why = g.allow_request("${DEAD}")
print(json.dumps({"ok": ok, "why": why}))
`));
    expect(cleared.ok).toBe(true);
    // ...and it stays cleared across a restart (the pop was persisted, not just
    // held in memory).
    expect(JSON.parse(fresh(probe(DEAD))).ok).toBe(true);
    expect(JSON.parse(readFileSync(STATE, "utf8")).cooldown).not.toHaveProperty(DEAD);
  });

  it("a corrupt state file must not block startup", () => {
    const saved = readFileSync(STATE, "utf8");
    writeFileSync(STATE, "not json{{");
    expect(JSON.parse(fresh(probe(ALIVE))).ok).toBe(true);
    writeFileSync(STATE, saved);
  });
});
