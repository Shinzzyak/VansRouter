"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import SegmentedControl from "@/shared/components/SegmentedControl";

// Compression (token-saver) section of the Usage page (9router-go parity:
// CompressionAnalyticsView). The endpoint drains the in-process events before
// answering, so a refresh always reflects everything the proxy has seen.
//
// The four windows are exactly the ones the endpoint resolves; anything else is
// silently read as 24h, so the picker offers no custom range.
const SINCE_OPTIONS = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "all", label: "All" },
];

export default function CompressionSection() {
  const [since, setSince] = useState("24h");
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/analytics/compression?since=${since}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to read compression analytics");
      setStats(data);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [since]);

  useEffect(() => {
    load();
  }, [load]);

  const dims = (map) =>
    Object.entries(map || {})
      .map(([key, row]) => ({ key, ...row }))
      .sort((a, b) => (b.tokensSaved || 0) - (a.tokensSaved || 0));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl options={SINCE_OPTIONS} value={since} onChange={setSince} size="sm" />
        <span className="text-xs text-text-muted">{loading ? "Loading…" : `${stats?.totalRequests ?? 0} requests`}</span>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Tokens saved" value={stats?.totalTokensSaved ?? "—"} />
        <Stat label="Avg savings" value={stats ? `${(stats.avgSavingsPct || 0).toFixed(1)}%` : "—"} />
        <Stat label="Skipped" value={stats?.totalSkipped ?? "—"} />
        <Stat label="Avg duration" value={stats ? `${stats.avgDurationMs}ms` : "—"} />
      </div>

      {["byMode", "byProvider", "byModel"].map((field) => {
        const rows = dims(stats?.[field]);
        if (!rows.length) return null;
        return (
          <Card key={field} title={TITLES[field]} padding="sm">
            <div className="flex flex-col gap-1">
              {rows.slice(0, 12).map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-3 border-b border-border-subtle pb-1 text-xs last:border-0">
                  <span className="min-w-0 truncate text-text-main">{row.key}</span>
                  <span className="shrink-0 text-text-muted">
                    {row.count}× · {row.tokensSaved} saved{row.avgSavingsPct ? ` · ${row.avgSavingsPct.toFixed(1)}%` : ""}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        );
      })}

      <p className="text-[11px] text-text-muted">
        {stats?.dimensionScope === "all-time"
          ? "Breakdowns are all-time; totals and the window honour the selection."
          : "Totals and breakdowns honour the selection."}{" "}
        Tokens are a byte estimate, not an upstream usage receipt.
      </p>
    </div>
  );
}

const TITLES = {
  byMode: "By mode",
  byProvider: "By provider",
  byModel: "By model",
};

function Stat({ label, value }) {
  return (
    <Card padding="xs">
      <p className="text-[11px] uppercase tracking-wide text-text-muted">{label}</p>
      <p className="text-lg font-semibold text-text-main">{value}</p>
    </Card>
  );
}
