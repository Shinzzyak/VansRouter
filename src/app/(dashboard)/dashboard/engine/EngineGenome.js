"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(Number(n) || 0);
const pct = (n) => `${((Number(n) || 0) * 100).toFixed(1)}%`;

function bytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function ago(iso) {
  if (!iso) return "—";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(d)) return "—";
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function Metric({ label, value, tone = "", note }) {
  return (
    <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
      <span className="text-text-muted text-sm uppercase font-semibold">{label}</span>
      <span className={`truncate text-2xl font-bold ${tone}`}>{value}</span>
      {note ? <span className="text-[10px] text-text-muted">{note}</span> : null}
    </Card>
  );
}

function Bar({ value, label, tone = "bg-primary" }) {
  const p = Math.max(0, Math.min(1, Number(value) || 0));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-border/60">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${(p * 100).toFixed(1)}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-text-muted">{label ?? pct(p)}</span>
    </div>
  );
}

function Section({ title, subtitle, children, right }) {
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle ? <p className="text-xs text-text-muted">{subtitle}</p> : null}
        </div>
        {right}
      </div>
      {children}
    </Card>
  );
}

const EMPTY = {
  ok: false,
  engineLoaded: false,
  genome: { available: false },
  ledger: { available: false, models: [] },
  corpus: { available: false, recent: [], byProvider: {}, shapes: {} },
};

export default function EngineGenome() {
  const [data, setData] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal) => {
    try {
      const res = await fetch("/api/engine/genome", { signal, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData({ ...EMPTY, ...json });
      setError(null);
    } catch (e) {
      if (e?.name !== "AbortError") setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    const timer = setInterval(() => load(), 30000);
    return () => {
      ac.abort();
      clearInterval(timer);
    };
  }, [load]);

  const genome = data.genome || EMPTY.genome;
  const ledger = data.ledger || EMPTY.ledger;
  const corpus = data.corpus || EMPTY.corpus;

  const routes = useMemo(
    () =>
      (ledger.models || []).flatMap((m) =>
        (m.routes || []).map((r) => ({ model: m.model, ...r }))
      ),
    [ledger.models]
  );

  const rungs = genome.rungs || [];
  const providerRows = Object.entries(corpus.byProvider || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const axes = genome.byAxis || {};
  const samples = corpus.recent || [];

  return (
    <div className="flex min-w-0 flex-col gap-4 px-1 sm:px-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Engine Genome</h1>
          <p className="text-xs text-text-muted">
            What the ladder invented, which route proved it, and the preambles we keep losing to.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-muted">
            {loading ? "loading…" : `updated ${ago(data.capturedAt)}`}
          </span>
          <button
            type="button"
            onClick={() => load()}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-subtle"
          >
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <Card className="border-error/40 p-3 text-sm text-error">
          Could not read the engine: {error}
        </Card>
      ) : null}

      {!data.engineLoaded ? (
        <Card className="border-warning/40 p-3 text-sm text-warning">
          Engine bundle not loaded — degraded plain-proxy mode. Numbers below are empty because
          the learner is absent, not because it has learned nothing.
        </Card>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 sm:gap-4">
        <Metric
          label="Rungs Alive"
          value={`${fmt(genome.count)}/${fmt(genome.cap)}`}
          tone="text-primary"
          note={`retire at ${pct(genome.retireRate)} after ${fmt(genome.minTriesToRetire)} tries`}
        />
        <Metric label="Models Tracked" value={fmt((ledger.models || []).length)} />
        <Metric
          label="Routes Tracked"
          value={fmt(routes.length)}
          note="provider/model — evidence needs 3 samples"
        />
        <Metric
          label="Corpus Samples"
          value={corpus.enabled ? fmt(corpus.samples) : "off"}
          tone="text-info"
          note={corpus.enabled ? `${fmt(corpus.distinct)} distinct · ${bytes(corpus.bytes)}` : "set VR_PROMPT_CORPUS=1"}
        />
        <Metric
          label="Identity Preambles"
          value={corpus.enabled ? fmt(corpus.shapes?.identityish) : "—"}
          tone="text-warning"
          note="claim to be a vendor, not a tool"
        />
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <Section
          title="Genome"
          subtitle="Rungs the engine wrote for itself. A rung is born from evidence, never from a template."
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {["UNIT", "SHAPE", "FORMAT", "PARTIAL"].map((axis) => {
              const a = axes[axis] || { rungs: 0, wins: 0, tries: 0 };
              return (
                <div key={axis} className="rounded border border-border bg-bg-subtle/40 p-2">
                  <div className="text-[10px] uppercase text-text-muted">{axis}</div>
                  <div className="text-sm font-semibold">{fmt(a.rungs)} rungs</div>
                  <div className="mt-1">
                    <Bar value={a.tries ? a.wins / a.tries : 0} label={`${fmt(a.wins)}/${fmt(a.tries)} won`} />
                  </div>
                </div>
              );
            })}
          </div>

          {!rungs.length ? (
            <p className="text-xs text-text-muted">
              {genome.available
                ? "No rung yet. The ladder only invents one after a model burns every built-in rung — an empty genome is the honest answer, not a failure."
                : "Genome unavailable — engine bundle not loaded."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border text-text-muted">
                    <th className="py-1.5 text-left font-semibold">Rung</th>
                    <th className="py-1.5 text-left font-semibold">Axis</th>
                    <th className="py-1.5 text-left font-semibold">Win rate</th>
                    <th className="py-1.5 text-left font-semibold">Text</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {rungs.map((r) => (
                    <tr key={r.id} className="hover:bg-bg-subtle transition-colors">
                      <td className="py-1.5 font-mono">{r.id}</td>
                      <td className="py-1.5">{r.axis}</td>
                      <td className="py-1.5 text-right">
                        <Bar value={r.rate} label={`${fmt(r.wins)}/${fmt(r.tries)}`} />
                      </td>
                      <td className="py-1.5 max-w-[280px] truncate text-text-muted" title={r.text}>
                        {r.text}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section
          title="Prompt corpus"
          subtitle={
            corpus.enabled
              ? `1 in ${fmt(corpus.every)} requests · rotates at ${bytes(corpus.maxBytes)} · ${bytes(corpus.bytes)} used`
              : "Off. Nothing is written to disk unless VR_PROMPT_CORPUS=1."
          }
          right={
            <span className="text-[10px] text-text-muted">
              {corpus.enabled ? `${fmt(corpus.samples)} samples` : "disabled"}
            </span>
          }
        >
          <div className="flex flex-wrap gap-2 text-[10px]">
            {[
              ["identity", corpus.shapes?.identityish],
              ["tool contract", corpus.shapes?.toolish],
              ["bullet walls", corpus.shapes?.bulletish],
              ["with tools", corpus.shapes?.withTools],
            ].map(([label, n]) => (
              <span key={label} className="rounded border border-border px-2 py-0.5 text-text-muted">
                {label} <span className="text-text font-semibold">{fmt(n)}</span>
              </span>
            ))}
          </div>

          {providerRows.length ? (
            <div className="flex flex-col gap-1">
              {providerRows.map(([name, n]) => (
                <div key={name} className="flex items-center gap-2 text-[10px]">
                  <span className="w-40 shrink-0 truncate font-mono text-text-muted" title={name}>
                    {name}
                  </span>
                  <Bar value={n / corpus.samples} label={fmt(n)} />
                </div>
              ))}
            </div>
          ) : null}

          {!samples.length ? (
            <p className="text-xs text-text-muted">
              {corpus.enabled
                ? "Enabled but empty — no request carried a system prompt yet."
                : "Disabled. Turn it on, let traffic flow, then read what arrives."}
            </p>
          ) : (
            <ul className="flex max-h-[320px] flex-col gap-2 overflow-y-auto pr-1">
              {[...samples].reverse().map((s, i) => (
                <li key={`${s.sha}-${i}`} className="rounded border border-border bg-bg-subtle/40 p-2">
                  <div className="flex flex-wrap items-center gap-2 text-[10px] text-text-muted">
                    <span className="font-mono text-text">{s.provider || "unknown"}</span>
                    <span>{s.model || "—"}</span>
                    <span>{fmt(s.len)} chars</span>
                    <span>{fmt(s.lines)} lines</span>
                    {s.tools ? <span>{fmt(s.tools)} tools</span> : null}
                    {s.identityish ? (
                      <span className="rounded bg-warning/15 px-1.5 py-0.5 text-warning">identity</span>
                    ) : null}
                    {s.toolish ? (
                      <span className="rounded bg-info/15 px-1.5 py-0.5 text-info">tool</span>
                    ) : null}
                    {s.bulletish ? (
                      <span className="rounded bg-primary/15 px-1.5 py-0.5 text-primary">bullets</span>
                    ) : null}
                    <span className="ml-auto">{ago(s.t)}</span>
                  </div>
                  <pre className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-text-muted">
                    {s.text}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section
        title="Route evidence"
        subtitle="Same model on two providers is two different walls. A route outranks the model only after 3 samples."
      >
        {!routes.length ? (
          <p className="text-xs text-text-muted">
            {ledger.available
              ? "No evidence yet — the ledger fills as escalations resolve."
              : "Ledger unavailable — engine bundle not loaded."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-border text-text-muted">
                  <th className="py-1.5 text-left font-semibold">Model</th>
                  <th className="py-1.5 text-left font-semibold">Route</th>
                  <th className="py-1.5 text-right font-semibold">Samples</th>
                  <th className="py-1.5 text-left font-semibold">Win rate</th>
                  <th className="py-1.5 text-left font-semibold">Best rung</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {routes.map((r) => (
                  <tr key={`${r.model}-${r.id}`} className="hover:bg-bg-subtle transition-colors">
                    <td className="py-1.5 font-mono">{r.model}</td>
                    <td className="py-1.5 font-mono text-text-muted">{r.id}</td>
                    <td className="py-1.5 text-right">
                      {fmt(r.n)}
                      {r.n < 3 ? <span className="ml-1 text-[10px] text-text-muted">(model-wide)</span> : null}
                    </td>
                    <td className="py-1.5">
                      <Bar value={r.tries ? r.wins / r.tries : 0} label={`${fmt(r.wins)}/${fmt(r.tries)}`} />
                    </td>
                    <td className="py-1.5">{r.best || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
