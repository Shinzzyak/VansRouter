import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/**
 * K232/K233 wiring — the engine modules are only real if the server actually
 * consults them. These are static assertions on purpose: they catch the exact
 * regression that matters (bundle loaded but never called, or a watermark that
 * starts editing the body).
 */
describe("rev55 watermark + heartbeat wiring", () => {
  const server = read("custom-server.js");
  const bundleScript = read("scripts/engine-bundle.mjs");

  it("patches writeHead once, from the engine bundle, fail-open", () => {
    expect(server).toMatch(/http\.ServerResponse\.prototype\.writeHead = function patchedWriteHead/);
    expect(server).toMatch(/require\("\.\/data\/engine\/engine\.cjs"\)/);
    expect(server).toMatch(/try \{[\s\S]{0,200}licenseStatusCached\(\)/);
    expect(server).toMatch(/catch \(_\) \{ \/\* never break a response/);
  });

  it("only sets a header when the response does not already carry it", () => {
    expect(server).toMatch(/if \(!this\.hasHeader\(key\)\) this\.setHeader\(key, marks\[key\]\)/);
  });

  it("never touches the response body", () => {
    // No write/end/send call inside the watermark block: header-only by design.
    const block = server.slice(server.indexOf("if (LICENCE && WATERMARK"));
    const end = block.indexOf("if (LICENCE && HEARTBEAT");
    const wm = block.slice(0, end);
    expect(wm).not.toMatch(/\.write\(|\.end\(|\.send\(|body/i);
  });

  it("starts the heartbeat with a re-read status function and an env-gated URL", () => {
    expect(server).toMatch(/url: process\.env\.VANSROUTER_HEARTBEAT_URL \|\| ""/);
    expect(server).toMatch(/readStatus: \(\) => LICENCE\.licenseStatusCached\(\)/);
    expect(server).toMatch(/if \(typeof first\.unref === "function"\) first\.unref\(\)/);
  });

  it("ships both modules in the engine bundle with fail-open fallbacks", () => {
    expect(bundleScript).toMatch(/"watermark",\s*\n\s*"heartbeat",/);
    expect(bundleScript).toMatch(/watermark: \{[\s\S]*?watermarkHeaders: "\(\(\) => \(\{\}\)\)"/);
    expect(bundleScript).toMatch(/heartbeat: \{[\s\S]*?startHeartbeat:/);
  });

  it("emits no watermark header shape change for a bundle-less router", () => {
    expect(bundleScript).toMatch(/watermarkHeaders: "\(\(\) => \(\{\}\)\)"/);
    expect(bundleScript).toMatch(/beatOnce: async \(\) => \(\{ ok: false, skipped: 'engine absent' \}\)/);
  });
});
