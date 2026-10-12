"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import { sentinelRows } from "@/lib/sentinel/rows";

// Sentinel: the read side of the engine's own telemetry.
//
// The engine already judges every reply — `classifyResponse` returns ok /
// refusal_text / missing_brand / missing_seal / empty, and the self-measuring
// bypass keeps a per-model escalation ledger. It also already writes all of it
// to disk and serves it from GET /api/engine/state. Nothing consumed that
// route: the engine could flag a provider as drifted and no human ever saw it.
//
// So this section invents no detection of its own. It fetches the route and
// renders one status row per model, drifted first. A model is DRIFT when
// either the refusal-drift window or the voice-cadence window says so; every
// other model with traffic is OK.
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
  const rows = sentinelRows(modules);
  const drifted = rows.filter((r) => r.status === "DRIFT");
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Models watched" value={loaded ? rows.length : "—"} />
        <Stat label="Drifted" value={loaded ? drifted.length : "—"} />
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
                className="flex items-center justify-between gap-3 border-b border-border-subtle pb-1 text-xs last:border-0"
              >
                <span className="min-w-0 flex-1 truncate text-text-main">{row.model}</span>
                <span className={`shrink-0 font-semibold ${row.status === "DRIFT" ? "text-red-500" : "text-emerald-500"}`}>
                  {row.status}
                </span>
                <span className="shrink-0 text-text-muted" title="share of judged replies that came back as a refusal">
                  {row.total ? `${Math.round(row.refusalRate * 100)}% refusal` : "—"}
                </span>
                <span className="shrink-0 text-text-muted" title="missing brand / missing seal out of judged replies">
                  brand {row.brandMiss} · seal {row.sealMiss}
                </span>
                <span className="shrink-0 text-text-muted" title="self-measuring bypass: best escalation level and last outcome">
                  {row.best ? `${row.best} · ${row.last}` : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-1 text-[11px] text-text-muted">
          Verdicts are the engine&apos;s own (<span className="text-text-main">classifyResponse</span>), not a
          second opinion. DRIFT = the refusal-drift or voice-cadence window flagged the model.
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

function Stat({ label, value }) {
  return (
    <Card padding="xs">
      <p className="text-[11px] uppercase tracking-wide text-text-muted">{label}</p>
      <p className="text-lg font-semibold text-text-main">{value}</p>
    </Card>
  );
}
