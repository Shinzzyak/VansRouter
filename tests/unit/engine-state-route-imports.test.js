// Guard for /api/engine/state's import style.
//
// FINDING (2026-09-23). The route shipped with the module specifier held in a
// VARIABLE — `const load = async (name, path, pick) => { await import(path) }`
// with a table of paths. Webpack cannot resolve a dynamic specifier, so it
// emitted a runtime `__webpack_require__(<string>)` and the deployed standalone
// server answered, for EVERY module:
//
//   {"available":false,"error":"Cannot find module 'open-sse/rtk/engineState.js'"}
//
// while the shim sat on disk beside the ones that worked. The failure is silent
// in the worst way: the route returns 200 with `ok:true` and the dashboard would
// read "engine has learned nothing yet" instead of "the read path is broken".
//
// This is a SOURCE-level guard on purpose. The behaviour cannot be unit-tested
// without a production build, and the regression is a one-line edit that looks
// like a cleanup — exactly the shape that needs a cheap tripwire.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const ROUTE = resolve(ROOT, "src/app/api/engine/state/route.js");
// Comments are stripped first: the file's own header documents the bad shape
// verbatim (`await import(path)`), and scanning the raw text made this guard
// fail on its own explanation.
const src = readFileSync(ROUTE, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("/api/engine/state imports the engine modules statically", () => {
  it("every module it reads is a static import", () => {
    for (const m of [
      "engineLoader",
      "engineState",
      "selfMeasuringBypass",
      "routeGuardMemory",
      "refusalDrift",
      "voiceCadence",
      "modelImmunityHints",
    ]) {
      expect(src, `${m} must be a static import`).toMatch(
        new RegExp(`import\\s*\\{[^}]*\\}\\s*from\\s*"open-sse/rtk/${m}\\.js"`),
      );
    }
  });

  it("no specifier is passed to import() as a value", () => {
    // The regression shape: import(<identifier>) or import(path) inside a loop
    // over a table. A string LITERAL is fine (and would also be bundled), a
    // variable is not.
    const dynamic = [...src.matchAll(/import\(\s*([^)"'][^)]*?)\s*\)/g)].map((m) => m[1].trim());
    expect(dynamic, `dynamic import() of a non-literal: ${dynamic.join(", ")}`).toEqual([]);
  });

  it("distinguishes a missing engine from an empty ledger", () => {
    // With the bundle absent every shim returns its neutral fallback, so an
    // empty ledger and a missing engine look identical unless the route asks.
    expect(src).toMatch(/isEngineLoaded/);
    expect(src).toMatch(/engineLoaded/);
  });
});
