"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import Input from "@/shared/components/Input";

// Semantic-cache section of the Usage page (9router-go parity: the cache
// analytics view). Reads the live cache, so the numbers shown are the numbers
// the router is serving from — no separate metric store to drift.
//
// Deliberately absent: prompt-cache tokens and the hourly trend. This router
// keeps no prompt-cache metric table, so the section shows what exists rather
// than a chart of zeroes.
export default function CacheSection() {
  const [stats, setStats] = useState(null);
  const [entries, setEntries] = useState([]);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const limit = 20;

  const loadStats = useCallback(async () => {
    const res = await fetch("/api/cache");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to read cache stats");
    setStats(data.cache || null);
  }, []);

  const loadEntries = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) qs.set("search", search);
    const res = await fetch(`/api/cache/entries?${qs.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to list cache entries");
    setEntries(data.entries || []);
    setTotal(data.total || 0);
  }, [page, search]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await Promise.all([loadStats(), loadEntries()]);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [loadStats, loadEntries]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch with an initial loading flag; setLoading(true) is intentional at the start of the request.
    refresh();
  }, [refresh]);

  const dropEntry = async (signature) => {
    await fetch(`/api/cache?signature=${encodeURIComponent(signature)}`, { method: "DELETE" });
    refresh();
  };

  const clearAll = async () => {
    await fetch("/api/cache", { method: "DELETE" });
    setPage(1);
    refresh();
  };

  const pageCount = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Hit rate" value={stats ? `${stats.hitRate}%` : "—"} />
        <Stat label="Hits" value={stats ? stats.hits : "—"} />
        <Stat label="Misses" value={stats ? stats.misses : "—"} />
        <Stat label="Entries" value={stats ? stats.memoryEntries : "—"} />
      </div>

      <Card
        title="Semantic cache"
        subtitle={stats ? `${stats.tokensSaved} tokens saved · TTL ${Math.round((stats.ttlMs || 0) / 1000)}s · cap ${stats.maxEntries}` : undefined}
        action={
          <div className="flex items-center gap-2">
            {stats && <Badge variant={stats.enabled ? "success" : "default"} size="sm">{stats.enabled ? "enabled" : "disabled"}</Badge>}
            <Button size="sm" variant="secondary" icon="refresh" onClick={refresh} disabled={loading}>Refresh</Button>
            <Button size="sm" variant="danger" icon="delete_sweep" onClick={clearAll} disabled={loading || !total}>Clear all</Button>
          </div>
        }
        padding="sm"
      >
        {error ? (
          <p className="text-sm text-red-500">{error}</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-text-muted">{loading ? "Loading…" : "Nothing cached yet."}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Input
                placeholder="Search signature or model"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              />
            </div>
            {entries.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 border-b border-border-subtle pb-2 last:border-0">
                <div className="min-w-0">
                  <p className="truncate text-xs text-text-main">{e.signature}</p>
                  <p className="text-[11px] text-text-muted">
                    {e.model || "unknown model"} · {e.hitCount} hits · {e.tokensSaved} tokens saved
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => dropEntry(e.signature)}
                  className="rounded p-1 text-text-muted hover:bg-red-500/10 hover:text-red-500"
                  title="Drop this entry"
                >
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </button>
              </div>
            ))}
            {pageCount > 1 && (
              <div className="flex items-center justify-end gap-2 pt-1">
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="rounded px-2 py-1 text-xs hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5">Prev</button>
                <span className="text-xs text-text-muted">{page} / {pageCount}</span>
                <button type="button" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount} className="rounded px-2 py-1 text-xs hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5">Next</button>
              </div>
            )}
          </div>
        )}
      </Card>
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
