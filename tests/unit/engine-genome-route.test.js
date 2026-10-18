// Guard for /api/engine/genome — the dashboard's only data source.
//
// Two failures are silent in this route and both look like "nothing learned yet"
// on screen, which is the single most expensive thing a measurement surface can
// say when the truth is "the reader is broken":
//
//   1. a DYNAMIC import of a shim (webpack cannot resolve the specifier, the
//      standalone server answers available:false for every module — measured
//      2026-09-23 on the sibling route);
//   2. a reader that is not wired at all, so the page renders an empty table
//      instead of an error.
//
// Source-level on purpose: the behaviour needs a production build to observe.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const ROUTE = resolve(ROOT, "src/app/api/engine/genome/route.js");
const PAGE = resolve(ROOT, "src/app/(dashboard)/dashboard/engine/EngineGenome.js");
// Comments stripped first: the route's header documents the bad shape verbatim.
const src = readFileSync(ROUTE, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("/api/engine/genome", () => {
  it("imports every engine module statically", () => {
    for (const m of ["engineLoader", "framingGenome", "promptCorpus", "selfMeasuringBypass"]) {
      expect(src, `${m} must be a static import`).toMatch(
        new RegExp(`import\\s*\\{[^}]*\\}\\s*from\\s*"open-sse/rtk/${m}\\.js"`),
      );
    }
  });

  it("no specifier is passed to import() as a value", () => {
    const dynamic = [...src.matchAll(/import\(\s*([^)"'][^)]*?)\s*\)/g)].map((m) => m[1].trim());
    expect(dynamic, `dynamic import() of a non-literal: ${dynamic.join(", ")}`).toEqual([]);
  });

  it("answers the three questions the page asks", () => {
    expect(src, "genome rows").toMatch(/genomeSnapshot\(/);
    expect(src, "ledger rows + routes").toMatch(/ledgerSnapshot\(/);
    expect(src, "corpus stats").toMatch(/corpusStats\(/);
    expect(src, "corpus samples").toMatch(/corpusTail\(/);
    // K167 — provider evidence is a separate book; the route must expose it or
    // the dashboard has no way to show which provider installs the wall.
    expect(src, "provider evidence").toMatch(/providerSnapshot\(/);
    expect(src, "providers array").toMatch(/providers:\s*providerSnapshot\(/);
    // K168 — the readiness panel is computed from the SAME ledger object the
    // route returns, so the numbers on screen cannot disagree with the table.
    expect(src, "synthesis readiness").toMatch(/synthesisReadiness\(/);
    expect(src, "synthesis key").toMatch(/synthesis:\s*\{/);
    expect(src, "explore cadence reported").toMatch(/exploreEvery:\s*EXPLORE_EVERY/);
  });

  it("separates a missing engine from an empty one", () => {
    expect(src).toMatch(/isEngineLoaded/);
    expect(src).toMatch(/engineLoaded/);
    expect(src, "no-bundle answers available:false").toMatch(/available:\s*false/);
  });

  it("is behind the shared dashboard guard", () => {
    expect(src).toMatch(/requireDashboardAuth/);
    expect(src).toMatch(/status:\s*401/);
  });
});

describe("EngineGenome page", () => {
  const page = readFileSync(PAGE, "utf8");

  it("reads the route, not a hardcoded value", () => {
    expect(page).toMatch(/fetch\("\/api\/engine\/genome"/);
  });

  it("renders the off state instead of an empty corpus", () => {
    // A corpus that is disabled and a corpus with zero samples are different
    // diagnoses; the page must say which one it is showing.
    expect(page).toMatch(/corpus\.enabled/);
    expect(page).toMatch(/VR_PROMPT_CORPUS/);
  });

  it("renders the no-bundle state instead of an empty genome", () => {
    expect(page).toMatch(/engineLoaded/);
    expect(page).toMatch(/available/);
  });
});
