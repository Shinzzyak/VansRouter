// The Sentinel tab of /dashboard/usage reads GET /api/engine/state.
//
// That route already existed and already served the engine's own verdicts
// (refusal drift per model, voice cadence, the escalation ledger, learned dead
// routes, family immunity). Nothing in the dashboard consumed it: the engine
// could flag a provider as drifted and no human ever saw it. The tab is the
// missing reader, not a new detector — so this test pins the two things that
// can silently break it:
//
//   1. the derivation folds the route's real payload shape correctly, including
//      the degraded shape the route returns when the engine bundle is absent
//      (available:false + empty arrays), and
//   2. the page actually mounts the section under tab=sentinel, and the section
//      reads the same module keys the route serves.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { sentinelRows, splitOutcome, filterVerdict } from "@/lib/sentinel/rows";

const ROOT = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// Trimmed from a live GET /api/engine/state on 2026-10-12: one model flagged by
// drift, one flagged only by cadence, one present in the ledger alone, and one
// clean model with traffic.
const LIVE_SHAPE = {
  refusalDrift: {
    drift: {
      "codebuddy-intl/deepseek-v4.1-flash": {
        total: 50,
        refusalRate: 0.06,
        brandViolationRate: 0.04,
        enclosureViolationRate: 0,
        drifted: false,
        counts: { total: 50, ok: 45, refusal_text: 3, missing_brand: 0, missing_seal: 2, empty: 0 },
      },
      "codebuddy-cn/deepseek-v4.1-flash": {
        total: 2,
        refusalRate: 0,
        drifted: true,
        counts: { total: 2, ok: 0, missing_brand: 2, missing_seal: 0, empty: 0 },
      },
      "bansos/glm-5.3-flash": {
        total: 300,
        refusalRate: 0,
        drifted: false,
        counts: { total: 300, ok: 300, missing_brand: 0, missing_seal: 0, empty: 0 },
      },
    },
  },
  voiceCadence: {
    cadence: [
      { model: "gpt-6-luna", avgScore: 55, window: 3, drifted: true },
      { model: "bansos/glm-5.3-flash", avgScore: 88, window: 10, drifted: false },
    ],
  },
  selfMeasuringBypass: {
    ledger: [
      { model: "bansos/glm-5.3-flash", n: 3093, wins: { T2: 16, T1: 2 }, best: "T2", last: "T2/AMBIGU" },
      { model: "codebuddy-cn/deepseek-v4.1-flash", n: 4, wins: {}, best: "T1", last: "T1/NOLAK" },
    ],
  },
  routeGuardMemory: { routes: { seed: ["ah", "nfh", "smt"], learned: [] } },
  modelImmunityHints: { hints: [] },
};

describe("sentinelRows", () => {
  it("flags a model DRIFT when the drift window says so, and carries its counts", () => {
    const rows = sentinelRows(LIVE_SHAPE);
    const row = rows.find((r) => r.model === "codebuddy-cn/deepseek-v4.1-flash");
    expect(row.status).toBe("DRIFT");
    expect(row.brandMiss).toBe(2);
    expect(row.sealMiss).toBe(0);
  });

  it("flags a model DRIFT when only the cadence window says so", () => {
    const rows = sentinelRows(LIVE_SHAPE);
    const row = rows.find((r) => r.model === "gpt-6-luna");
    expect(row.status).toBe("DRIFT");
    expect(row.cadenceScore).toBe(55);
  });

  it("keeps a clean model OK and merges its drift, cadence and ledger rows into one", () => {
    const rows = sentinelRows(LIVE_SHAPE);
    const row = rows.find((r) => r.model === "bansos/glm-5.3-flash");
    expect(row.status).toBe("OK");
    expect(row.total).toBe(300);
    expect(row.best).toBe("T2");
    expect(row.last).toBe("T2/AMBIGU");
    expect(row.cadenceScore).toBe(88);
    // one row per model, not one per window
    expect(rows.filter((r) => r.model === "bansos/glm-5.3-flash")).toHaveLength(1);
  });

  it("sorts drifted first, then by traffic", () => {
    const rows = sentinelRows(LIVE_SHAPE);
    expect(rows.slice(0, 2).every((r) => r.status === "DRIFT")).toBe(true);
    // the busiest clean model leads the OK block; the quietest closes the list
    expect(rows[2].model).toBe("bansos/glm-5.3-flash");
    expect(rows[rows.length - 1].model).toBe("codebuddy-intl/deepseek-v4.1-flash");
  });

  it("does not carry a stale DRIFT when a window reports drifted:false", () => {
    const rows = sentinelRows(LIVE_SHAPE);
    const row = rows.find((r) => r.model === "codebuddy-intl/deepseek-v4.1-flash");
    expect(row.status).toBe("OK");
    expect(row.sealMiss).toBe(2); // the violation is still visible without the DRIFT label
  });

  it("returns nothing for the degraded payload the route serves without an engine bundle", () => {
    // the real degraded shape: available:false + the fallback empty values
    const degraded = {
      refusalDrift: { available: false, drift: {} },
      voiceCadence: { available: false, cadence: [] },
      selfMeasuringBypass: { available: false, ledger: [] },
    };
    expect(sentinelRows(degraded)).toEqual([]);
    expect(sentinelRows(undefined)).toEqual([]);
    expect(sentinelRows({})).toEqual([]);
  });

  it("skips rows with no model id instead of emitting a nameless status", () => {
    const rows = sentinelRows({
      refusalDrift: { drift: { "": { total: 1, drifted: true } } },
      voiceCadence: { cadence: [{ avgScore: 10, drifted: true }] },
    });
    expect(rows).toEqual([]);
  });
});

// The filter axis. The engine's ledger already carries it — `last` is
// "<tier>/<class>" and the class is whether the request actually got through the
// model's own filter. The tab showed the raw string and nothing named the axis,
// so "T2/SENYAP" was readable only to someone who already knew the vocabulary.
describe("filter axis", () => {
  it("splits the tier off the outcome class", () => {
    expect(splitOutcome("T2/PATUH")).toEqual({ tier: "T2", outcome: "PATUH" });
    expect(splitOutcome("T1/NOLAK")).toEqual({ tier: "T1", outcome: "NOLAK" });
    // a bare class is still an outcome, and unknown casing normalizes
    expect(splitOutcome("patuh")).toEqual({ tier: "", outcome: "PATUH" });
    expect(splitOutcome("")).toEqual({ tier: "", outcome: "" });
    expect(splitOutcome(undefined)).toEqual({ tier: "", outcome: "" });
  });

  it("maps each class to open / blocked / warn / unknown", () => {
    expect(filterVerdict("PATUH").tone).toBe("open");
    expect(filterVerdict("NOLAK").tone).toBe("blocked");
    expect(filterVerdict("FILTER_UPSTREAM").tone).toBe("blocked");
    expect(filterVerdict("SENYAP").tone).toBe("warn");
    expect(filterVerdict("SUBSTITUSI").tone).toBe("warn");
    expect(filterVerdict("AMBIGU").tone).toBe("warn");
    expect(filterVerdict("INFRA").tone).toBe("unknown");
    // an unseen class is shown verbatim rather than swallowed
    expect(filterVerdict("SOMETHING_NEW")).toEqual({ filter: "SOMETHING_NEW", tone: "unknown" });
    expect(filterVerdict("")).toEqual({ filter: "—", tone: "unknown" });
  });

  it("carries the verdict onto the row from the ledger's last outcome", () => {
    const rows = sentinelRows({
      selfMeasuringBypass: {
        ledger: [
          { model: "za/glm-5.3-flash", n: 10, wins: {}, best: "T2", last: "T2/PATUH" },
          { model: "cbai/deepseek-v4.1-flash", n: 9, wins: {}, best: "T2", last: "T2/NOLAK" },
          { model: "gemini-3.6-flash-high", n: 8, wins: {}, best: "T2", last: "T2/SENYAP" },
        ],
      },
    });

    const byModel = Object.fromEntries(rows.map((r) => [r.model, r]));
    expect(byModel["za/glm-5.3-flash"].filter).toBe("PATUH");
    expect(byModel["za/glm-5.3-flash"].filterTone).toBe("open");
    expect(byModel["za/glm-5.3-flash"].tier).toBe("T2");
    expect(byModel["cbai/deepseek-v4.1-flash"].filterTone).toBe("blocked");
    expect(byModel["gemini-3.6-flash-high"].filterTone).toBe("warn");
  });

  it("leaves a model with no ledger row on the unknown verdict", () => {
    const rows = sentinelRows({
      refusalDrift: { drift: { "za/glm-5.3-flash": { total: 5, drifted: false } } },
    });
    expect(rows[0].filter).toBe("—");
    expect(rows[0].filterTone).toBe("unknown");
  });
});

describe("sentinel wiring", () => {
  const page = read("src/app/(dashboard)/dashboard/usage/page.js");
  const section = read("src/app/(dashboard)/dashboard/usage/components/SentinelSection.js");
  const route = read("src/app/api/engine/state/route.js");

  it("mounts the section under tab=sentinel and offers the tab", () => {
    expect(page).toMatch(/import SentinelSection from "\.\/components\/SentinelSection"/);
    expect(page).toMatch(/activeTab === "sentinel" && <SentinelSection \/>/);
    // the tab must also be in the allow-list, or ?tab=sentinel falls back to Overview
    expect(page).toMatch(/\["overview", "logs", "details", "cache", "compression", "sentinel"\]/);
    expect(page).toMatch(/\{ value: "sentinel", label: "Sentinel" \}/);
  });

  it("reads the route that serves the engine telemetry", () => {
    expect(section).toMatch(/fetch\("\/api\/engine\/state"/);
    expect(route).toMatch(/requireDashboardAuth\(request\)/);
  });

  it("derives the tiles, the header and the table from one snapshot", () => {
    // A separate `loading` flag used to exist next to the snapshot, and the tab
    // could render tiles stuck at "—" beside a table that already had rows.
    // Loading must mean "no snapshot yet", not a second piece of state.
    expect(section).not.toMatch(/useState\(true\)/);
    expect(section).toMatch(/const loaded = state !== null;/);
    for (const tile of ["Models watched", "Drifted", "Filter open", "Filter blocked", "Dead routes", "Filtered routes"]) {
      expect(section).toMatch(new RegExp(`label="${tile}" value=\\{loaded \\?`));
    }
    // the filter chip is rendered per row and coloured from the tone map
    expect(section).toMatch(/FILTER_TONE_CLASS\[row\.filterTone\]/);
    expect(section).toMatch(/\{row\.filter\}/);
    // a stalled body read must not leave the tab spinning forever
    expect(section).toMatch(/AbortSignal\.timeout\(/);
  });

  it("reads the same module keys the route serves", () => {
    // the per-model windows are read by the derivation module …
    const rows = read("src/lib/sentinel/rows.js");
    for (const key of ["selfMeasuringBypass", "refusalDrift", "voiceCadence"]) {
      expect(route).toContain(`${key}: read(loaded`);
      expect(rows).toContain(key);
    }
    // … and the two list-shaped windows by the section itself
    for (const key of ["routeGuardMemory", "modelImmunityHints"]) {
      expect(route).toContain(`${key}: read(loaded`);
      expect(section).toContain(key);
    }
  });

  it("keeps the derivation in the JSX-free module the test can import", () => {
    // The binding matters, not the exact brace list — `sentinelTotals` was added
    // beside `sentinelRows` and the assertion must not have to be rewritten every
    // time the module exports one more helper.
    expect(section).toMatch(/import \{[^}]*\bsentinelRows\b[^}]*\} from "@\/lib\/sentinel\/rows"/);
    expect(section).not.toMatch(/export function sentinelRows/);
  });

  it("gives the model label the whole row on a phone", () => {
    // `break-all` on a label that shares its line with six counters has a
    // one-character sliver to work with on a phone, so a long key rendered one
    // character per line. The label must own the row below `sm` and go back to
    // a single truncated line from `sm` up.
    const label = section.match(/<span className="([^"]*)" title=\{row\.model\}>/);
    expect(label).not.toBeNull();
    const cls = label[1];
    expect(cls).toContain("w-full");
    expect(cls).toContain("sm:flex-1");
    expect(cls).toContain("sm:truncate");
    // …and the row has to be allowed to wrap, or the full-width label just
    // pushes the counters off the card instead of stacking them.
    expect(section).toMatch(/flex flex-wrap items-baseline[^"]*"/);
  });
});
