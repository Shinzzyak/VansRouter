"use client";

import { useCallback, useEffect, useState } from "react";
import Badge from "./Badge";
import { readJsonResponse } from "@/shared/utils/httpResponse.js";

function StatusDot({ ok }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        ok ? "bg-green-500" : "bg-red-500"
      }`}
    />
  );
}

/**
 * Proxy status panel — gateway 8081 (sticky pool) + WARP :40000 (mode proxy).
 * Dipakai di Account Pool & Automation pages. Data dari /api/proxy-gateway/status.
 */
export default function ProxyStatusPanel({ compact = false }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/proxy-gateway/status", { cache: "no-store" });
      const data = await readJsonResponse(res);
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-zinc-400">
        Checking proxy status…
      </div>
    );
  }

  if (error || !status) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-zinc-400">
        Proxy status unavailable
        <button className="ml-2 underline" onClick={load}>Retry</button>
      </div>
    );
  }

  const gw = status.gateway || {};
  const warp = status.warp || {};
  const regionEntries = Object.entries(gw.regions || {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Proxy Status
        </p>
        <button
          onClick={load}
          className="material-symbols-outlined text-[16px] text-zinc-500 hover:text-zinc-300"
          title="Refresh"
        >
          refresh
        </button>
      </div>

      <div className="mt-2 space-y-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-zinc-300">
            <StatusDot ok={gw.online} />
            Gateway 8081
          </span>
          <span className="text-zinc-400">
            {gw.online ? `${gw.alive} alive · ${gw.blocked} blocked` : "offline"}
          </span>
        </div>

        {gw.online && regionEntries.length > 0 && (
          <div className="flex flex-wrap gap-1 pl-3.5">
            {regionEntries.map(([region, count]) => (
              <Badge key={region} variant="default" size="sm">
                {region} ×{count}
              </Badge>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-zinc-300">
            <StatusDot ok={warp.online} />
            WARP :40000
          </span>
          <span className="text-zinc-400">
            {warp.online ? (warp.egressIp ? `egress ${warp.egressIp}` : "online") : "offline"}
          </span>
        </div>

        {!compact && (
          <p className="text-[11px] text-zinc-500">
            Gateway sticky: ganti <code className="rounded bg-white/10 px-1">sid-XXXX</code> = IP baru.
            WARP mode proxy — IP publik VPS tidak berubah.
          </p>
        )}
      </div>
    </div>
  );
}
