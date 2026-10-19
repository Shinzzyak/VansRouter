"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import { sentinelRows, sentinelTotals } from "@/lib/sentinel/rows";

// Tone per filter verdict, so the chip colour comes from one map instead of a
// chain of ternaries in JSX.
const FILTER_TONE_CLASS = {
  open: "text-emerald-500",
  blocked: "text-red-500",
  warn: "text-amber-500",
  unknown: "text-text-muted",
};

// Contract health is a RATE, so its tile is coloured from the rate — not from
// whether any model happens to be red. "Drifted 0" beside "45% of replies lost
// the brand line" is exactly the reading this map exists to prevent.
const HEALTH_TONE_CLASS = {
  good: "text-emerald-500",
  warn: "text-amber-500",
  bad: "text-red-500",
  none: "text-text-main",
};

function contractTone(rate) {
  if (rate === null || rate === undefined) return "none";
  if (rate < 0.9) return "bad";
  if (rate < 0.99) return "warn";
  return "good";
}

// Sentinel: the read side of the engine's own telemetry.
//
// The engine already judges every reply — `classifyResponse` returns ok /
// refusal_text / missing_brand / missing_seal / empty, and the self-measuring
// bypass keeps a per-model escalation ledger. It also already writes all of it
// to disk and serves it from GET /api/engine/state. Nothing consumed that
// route: the engine could flag a provider as drifted and no human ever saw it.
//
// So this section invents no detection of its own. It fetches the route and
// renders one status row per model, drifted first. A model is DRIFT when the
// drift window flags it on ANY axis — refusal, brand or enclosure — or when the
// voice-cadence window says so; every other model with traffic is OK. The
// contract tiles above the table count REPLIES rather than models, because a
// model count cannot show that a third of the traffic lost the brand line.
export default function SentinelSection() {
  // One piece of state, not two. The tiles, the header and the table all read
  // this same snapshot, so they cannot disagree: an earlier version kept a
  // separate `loading` flag and the tab could render tiles stuck at "—" (and a
  // header stuck at "Loading…") next to a table that already had rows. The
  // engine route answers in ~120ms, so "still loading" must mean "no snapshot".
  const [state, setState] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    // The signal aborts the body read too, so a stalled response cannot leave
    // the tab spinning forever; one retry covers a dropped socket, a second
    // stall surfaces as the error line.
    const once = async () => {
      const res = await fetch("/api/engine/state", { signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to read engine state");
      return data;
    };
    try {
      let data;
      try {
        data = await once();
      } catch {
        data = await once();
      }
      setState(data);
    } catch (err) {
      setError(err?.message || String(err));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; setError("") is intentional at the start of the request.
    load();
  }, [load]);

  const loaded = state !== null;
  const modules = state?.modules || null;
  // The persisted file is the union of every engine instance in this process;
  // the in-memory ledger only sees traffic that landed in this chunk (measured
  // 2026-10-19: 34 live requests moved the file by 151 and this snapshot by 0).
  // Prefer the file, and print which one the table is showing.
  const persisted = state?.persisted || null;
  const ledger = persisted?.available ? persisted : modules?.selfMeasuringBypass || null;
  const rows = sentinelRows({ ...(modules || {}), selfMeasuringBypass: { ledger: ledger?.ledger || [] } });
  const totals = sentinelTotals(rows);
  const drifted = rows.filter((r) => r.status === "DRIFT");
  const filterOpen = rows.filter((r) => r.filterTone === "open").length;
  const filterBlocked = rows.filter((r) => r.filterTone === "blocked").length;
  const learned = modules?.routeGuardMemory?.routes?.learned || [];
  const hints = modules?.modelImmunityHints?.hints || [];
  const engineLoaded = state?.engineLoaded;

  return (
    // ponytail: keyed on the snapshot so a subtree from the previous load can
    // never survive into the next one; drop the key if it ever costs a repaint.
    <div key={loaded ? "loaded" : "loading"} className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-text-muted">
          {!loaded
            ? error
              ? "could not read engine state"
              : "Loading…"
            : engineLoaded === false
              ? "engine bundle not loaded (degraded plain-proxy mode)"
              : `captured ${state?.capturedAt ? new Date(state.capturedAt).toLocaleTimeString() : "—"}`}
        </span>
        <button
          type="button"
          onClick={load}
          className="rounded border border-border-subtle px-2 py-1 text-xs text-text-main hover:bg-surface-hover"
        >
          Refresh
        </button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* The contract axis, in the unit that matters. The row below counts
          MODELS; this one counts REPLIES. Without it the tab could read
          "Drifted 0" in green while a third of all replies had lost the brand
          line — 172 watched models is a coverage number, not a health number. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Judged replies" value={loaded ? totals.judged : "—"} />
        <Stat
          label="Answered"
          value={loaded ? (totals.answeredRate === null ? "—" : `${(totals.answeredRate * 100).toFixed(1)}%`) : "—"}
          tone={contractTone(totals.answeredRate)}
          title={`${totals.answered} of ${totals.judged} judged replies came back with visible text; the rest were empty or filtered. This is the axis that separates "listed in the roster" from "actually answers".`}
        />
        <Stat
          label="Model self-brand"
          value={loaded ? (totals.contractOk === null ? "—" : `${(totals.contractOk * 100).toFixed(1)}%`) : "—"}
          tone={contractTone(totals.contractOk)}
          title="Share of judged replies where the MODEL itself wrote the brand line, the seal and the enclosure. This is the axis the stream gate repairs — read it beside Delivered contract, which is the same question asked on the client's side."
        />
        <Stat
          label="Model contract misses"
          value={loaded ? totals.broken : "—"}
          tone={totals.broken ? "warn" : "none"}
          title={`replies the model left un-branded — brand ${totals.brandMiss} · seal ${totals.sealMiss} · enclosure ${totals.enclosureMiss}. Measured on the model's own output, upstream of the gate.`}
        />
        <Stat
          label="Delivered contract"
          value={loaded ? (totals.deliveredRate === null ? "—" : `${(totals.deliveredRate * 100).toFixed(1)}%`) : "—"}
          tone={contractTone(totals.deliveredRate)}
          title={`Share of delivered replies that reached the client carrying brand + seal + enclosure, measured AFTER the gate ran — ${totals.deliveredJudged} replies, ${totals.deliveredBroken} short. Read beside Model self-brand: a wide gap means the models are drifting and the gate is carrying them; a delivered number BELOW the model number would mean the gate is the bug.`}
        />
        <Stat
          label="Drifted models"
          value={loaded ? drifted.length : "—"}
          tone={drifted.length ? "bad" : "none"}
          title="Models over threshold on refusal, brand or enclosure inside their own 50-sample window. The brand axis counts the model's own output, so a model that leans on the gate reads as drifted."
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Models watched" value={loaded ? rows.length : "—"} />
        <Stat label="Drifted" value={loaded ? drifted.length : "—"} />
        <Stat label="Filter open" value={loaded ? filterOpen : "—"} />
        <Stat label="Filter blocked" value={loaded ? filterBlocked : "—"} />
        <Stat label="Dead routes" value={loaded ? learned.filter((r) => r.kind === "dead").length : "—"} />
        <Stat label="Filtered routes" value={loaded ? learned.filter((r) => r.kind === "filtered").length : "—"} />
      </div>

      <Card title="Status by model" padding="sm">
        {rows.length === 0 ? (
          <p className="text-xs text-text-muted">
            {!loaded
              ? error
                ? "Engine state could not be read — use Refresh to retry."
                : "Loading…"
              : "No model has been judged yet — the windows fill as traffic flows."}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {rows.slice(0, 40).map((row) => (
              <div
                key={row.model}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-border-subtle pb-1 text-xs last:border-0"
              >
                {/* The model key is the one field that can outrun the row — a
                    multi-slash key runs past 60 chars. On a phone the label
                    shared the line with six counters, so `break-all` had a
                    one-character sliver to work with and stacked the name
                    vertically. Below `sm` the label gets the whole row; from
                    `sm` up it goes back to a single truncated line. */}
                <span className="w-full min-w-0 break-all text-text-main sm:w-auto sm:flex-1 sm:truncate" title={row.model}>
                  {row.shortModel}
                </span>
                <span
                  className={`shrink-0 font-semibold ${FILTER_TONE_CLASS[row.filterTone] || "text-text-muted"}`}
                  title="engine's own class for this model's last reply — PATUH = filter passed, NOLAK/FILTER_UPSTREAM = blocked, SENYAP/SUBSTITUSI/AMBIGU = no usable answer"
                >
                  {row.filter}
                </span>
                <span
                  className={`shrink-0 font-semibold ${row.status === "DRIFT" ? "text-red-500" : "text-emerald-500"}`}
                  title={row.status === "DRIFT" ? `over threshold on: ${row.driftAxes.join(", ") || "engine flag"}` : "inside every window"}
                >
                  {row.status}
                </span>
                <span
                  className={`shrink-0 ${row.total && row.answeredRate < 0.9 ? "text-amber-500" : "text-text-muted"}`}
                  title="share of judged replies that came back with visible text — listed in the roster is not the same as able to answer"
                >
                  {row.total ? `${Math.round(row.answeredRate * 100)}% ans` : "—"}
                </span>
                <span className="shrink-0 text-text-muted" title="share of judged replies that came back as a refusal">
                  {row.total ? `${Math.round(row.refusalRate * 100)}% refusal` : "—"}
                </span>
                <span
                  className={`shrink-0 ${row.brandMiss + row.sealMiss + row.enclosureMiss ? "text-red-500" : "text-text-muted"}`}
                  title="missing brand / missing seal / missing enclosure out of judged replies, measured on the MODEL's own output (upstream of the gate)"
                >
                  brand {row.brandMiss} · seal {row.sealMiss} · encl {row.enclosureMiss}
                </span>
                <span
                  className={`shrink-0 ${row.deliveredRate === null ? "text-text-muted" : row.deliveredRate < 0.99 ? "text-amber-500" : "text-emerald-500"}`}
                  title={row.deliveredTotal
                    ? `the gate's own verdict on what the client received: ${row.deliveredOk} of ${row.deliveredTotal} delivered replies carried the full contract. Read beside the model numbers — a wide gap means the gate is carrying this model.`
                    : "no delivered sample for this model yet"}
                >
                  {row.deliveredRate === null ? "→ —" : `→ ${Math.round(row.deliveredRate * 100)}% out`}
                </span>
                <span className="shrink-0 text-text-muted" title="self-measuring bypass: best escalation level and last outcome">
                  {row.best ? `${row.best} · ${row.last}` : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-1 text-[11px] text-text-muted">
          Ledger source:{" "}
          <span className="text-text-main">{persisted?.available ? "state file (union)" : "this process only"}</span>
          {persisted?.available && persisted.savedAt ? ` · saved ${persisted.savedAt.slice(11, 19)}Z` : ""}
          {persisted?.available ? ` · ${persisted.rows} routes, ${persisted.total_n} outcomes` : ""}
        </p>
        <p className="mt-1 text-[11px] text-text-muted">
          Verdicts are the engine&apos;s own (<span className="text-text-main">classifyResponse</span>), not a
          second opinion. DRIFT = a model crossed the threshold inside its own 50-sample window on{" "}
          <span className="text-red-500">refusal</span>, <span className="text-red-500">brand</span> or{" "}
          <span className="text-red-500">enclosure</span> — hover the verdict to see which. The
          second column is the filter axis: <span className="text-emerald-500">PATUH</span> means the
          model answered through its own filter, <span className="text-red-500">NOLAK</span> /{" "}
          <span className="text-red-500">FILTER_UPSTREAM</span> means it did not, and{" "}
          <span className="text-amber-500">SENYAP</span> /{" "}
          <span className="text-amber-500">SUBSTITUSI</span> /{" "}
          <span className="text-amber-500">AMBIGU</span> means there was no usable answer to judge.{" "}
          <span className="text-text-main">% ans</span> is the share of judged replies that came back
          with visible text — being listed in the roster is not the same as being able to answer. The
          brand / seal / enclosure counts are what the <span className="text-text-main">model</span>{" "}
          wrote. The <span className="text-text-main">→ % out</span> column is the other side of the
          gate: the share of delivered replies that reached the client with the full contract, as the
          gate itself reports it. A wide gap between the two means the models are drifting and the
          gate is carrying them — the model numbers alone would read that as a broken product.
        </p>
      </Card>

      {learned.length > 0 && (
        <Card title="Route guard memory" padding="sm">
          <div className="flex flex-col gap-1">
            {learned.slice(0, 12).map((route) => (
              <div
                key={`${route.prefix}-${route.kind}`}
                className="flex items-start justify-between gap-3 border-b border-border-subtle pb-1 text-xs last:border-0"
              >
                <span className="min-w-0 flex-1 truncate text-text-main">{route.prefix}</span>
                <span className={`shrink-0 font-semibold ${route.kind === "dead" ? "text-red-500" : "text-amber-500"}`}>
                  {route.kind}
                </span>
                <span className="min-w-0 flex-[2] truncate text-right text-text-muted">{route.evidence}</span>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-text-muted">
            Prefixes the engine learned at runtime. Seed: {(modules?.routeGuardMemory?.routes?.seed || []).join(", ") || "—"}
          </p>
        </Card>
      )}

      {hints.length > 0 && (
        <Card title="Family immunity" padding="sm">
          <div className="flex flex-col gap-1">
            {hints.map((hint) => (
              <div
                key={hint.family}
                className="flex items-center justify-between gap-3 border-b border-border-subtle pb-1 text-xs last:border-0"
              >
                <span className="min-w-0 truncate text-text-main">{hint.family}</span>
                <span className="shrink-0 text-text-muted">{hint.uniformity}</span>
                <span className="min-w-0 flex-[2] truncate text-right text-text-muted">{hint.measured}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "none", title }) {
  return (
    <Card padding="xs">
      <p className="text-[11px] uppercase tracking-wide text-text-muted" title={title}>{label}</p>
      <p className={`text-lg font-semibold ${HEALTH_TONE_CLASS[tone] || HEALTH_TONE_CLASS.none}`} title={title}>{value}</p>
    </Card>
  );
}
