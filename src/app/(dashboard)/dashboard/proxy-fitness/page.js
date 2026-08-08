"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardSkeleton, Input, ConfirmModal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

function recordsOf(fitness, pools, now = Date.now()) {
  const names = new Map((pools || []).map((p) => [p.id, p]));
  return Object.entries(fitness || {}).flatMap(([poolId, scopes]) => Object.entries(scopes || {}).flatMap(([scope, info]) => {
    const until = Number(info?.until || 0);
    if (until <= now) return [];
    const [provider, model] = String(scope).split("::");
    const pool = names.get(poolId);
    return [{ poolId, scope, provider, model: model === "*" ? "all models" : model, until, reason: info?.reason || "blocked", poolName: pool?.name || poolId.slice(0, 8), proxyUrl: pool?.proxyUrl || "" }];
  }));
}

export default function ProxyFitnessPage() {
  const [pools, setPools] = useState([]);
  const [fitness, setFitness] = useState({});
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState("all");
  const [search, setSearch] = useState("");
  const [confirm, setConfirm] = useState(false);
  const notify = useNotificationStore();
  const fetchAll = useCallback(async () => {
    try {
      const [p, f] = await Promise.all([fetch("/api/proxy-pools?includeUsage=true", { cache: "no-store" }), fetch("/api/proxy-pools/fitness", { cache: "no-store" })]);
      setPools((await p.json()).proxyPools || []);
      setFitness(f.ok ? ((await f.json()).pools || {}) : {});
    } catch {
      // Keep the empty state when the dashboard APIs are unavailable.
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAll();
  }, [fetchAll]);
  const records = useMemo(() => recordsOf(fitness, pools).filter((r) => (provider === "all" || r.provider === provider) && `${r.proxyUrl} ${r.poolName} ${r.model}`.toLowerCase().includes(search.toLowerCase())), [fitness, pools, provider, search]);
  const providers = useMemo(() => [...new Set(recordsOf(fitness, pools).map((r) => r.provider))].sort(), [fitness, pools]);
  const clearAll = async () => {
    await fetch("/api/proxy-pools/fitness/clear-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(provider === "all" ? {} : { provider }) });
    setConfirm(false); notify.success("Proxy fitness cleared"); fetchAll();
  };
  return <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
    {loading ? <CardSkeleton /> : <>
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><h1 className="text-lg font-semibold">Proxy Fitness</h1><Badge variant={records.length ? "error" : "default"}>{records.length} active blocks</Badge></div><div className="flex gap-2"><Button variant="secondary" size="sm" onClick={fetchAll}>Refresh</Button>{records.length > 0 && <Button variant="danger" size="sm" onClick={() => setConfirm(true)}>Clear All</Button>}</div></div>
      <p className="text-sm text-text-muted">Smart rotation skips pools marked unfit for a provider/model.</p>
      <div className="flex flex-wrap gap-3"><select value={provider} onChange={(e) => setProvider(e.target.value)} className="rounded border border-border bg-bg px-2 py-2 text-sm"><option value="all">All providers</option>{providers.map((p) => <option key={p}>{p}</option>)}</select><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="IP / proxy / pool" icon="search" /></div>
      <Card className="overflow-x-auto p-0"><table className="w-full min-w-[650px] text-sm"><thead><tr className="border-b border-border-subtle text-left text-xs uppercase text-text-muted"><th className="px-4 py-2">Provider</th><th className="px-4 py-2">Model</th><th className="px-4 py-2">Pool</th><th className="px-4 py-2">Reason</th><th className="px-4 py-2">Until</th><th /></tr></thead><tbody>{records.length ? records.map((r) => <tr key={`${r.poolId}:${r.scope}`} className="border-b border-border-subtle"><td className="px-4 py-3">{r.provider}</td><td className="px-4 py-3">{r.model}</td><td className="px-4 py-3">{r.poolName}</td><td className="px-4 py-3">{r.reason}</td><td className="px-4 py-3">{new Date(r.until).toLocaleTimeString()}</td><td className="px-4 py-3"><Button variant="ghost" size="sm" onClick={async () => { await fetch(`/api/proxy-pools/${r.poolId}/fitness/clear`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: r.scope }) }); fetchAll(); }}>Clear</Button></td></tr>) : <tr><td colSpan={6} className="px-4 py-10 text-center text-text-muted">No active blocks.</td></tr>}</tbody></table></Card>
    </>}
    <ConfirmModal isOpen={confirm} onClose={() => setConfirm(false)} onConfirm={clearAll} title="Clear proxy fitness" message="Clear active proxy fitness blocks?" confirmText="Clear All" cancelText="Cancel" variant="danger" />
  </div>;
}

export { recordsOf };
