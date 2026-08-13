"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Modal from "@/shared/components/Modal";
import { ConfirmModal } from "@/shared/components/Modal";
import ProviderIcon from "@/shared/components/ProviderIcon";
import ProxyStatusPanel from "@/shared/components/ProxyStatusPanel";
import { readJsonResponse } from "@/shared/utils/httpResponse.js";

function formatTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

// Benefit formatter — trial sisa hari / free limit / points
function formatBenefit(benefit) {
  if (!benefit) return "—";
  if (benefit.message) return benefit.message;
  if (benefit.error) return "err";
  if (!benefit.quotas?.length) return benefit.plan || "—";

  const parts = [];
  for (const q of benefit.quotas.slice(0, 3)) {
    if (q.unlimited) {
      parts.push(`${q.key}: unlimited`);
      continue;
    }
    const remaining = Number.isFinite(q.remaining) ? q.remaining : q.total - q.used;
    if (q.resetAt) {
      const days = Math.max(0, Math.ceil((new Date(q.resetAt) - Date.now()) / 86400000));
      parts.push(`${q.key}: ${remaining} left · ${days}d`);
    } else {
      parts.push(`${q.key}: ${remaining}/${q.total}`);
    }
    if (q.expiring?.text) {
      parts.push(`⚠ ${q.expiring.text}`);
    }
  }
  if (benefit.sandbox) {
    parts.push(`🦞 ${benefit.sandbox.status}`);
  }
  return parts.join(" · ");
}

function getStatusVariant(conn) {
  if (!conn.isActive) return "default";
  if (conn.rateLimitedUntil && new Date(conn.rateLimitedUntil) > new Date()) return "warning";
  if (conn.testStatus === "failed") return "danger";
  if (conn.testStatus === "active" || conn.testStatus === "ok") return "success";
  return "info";
}

function getStatusLabel(conn) {
  if (!conn.isActive) return "inactive";
  if (conn.rateLimitedUntil && new Date(conn.rateLimitedUntil) > new Date()) return "rate limited";
  if (conn.testStatus === "failed") return "failed";
  if (conn.testStatus === "active" || conn.testStatus === "ok") return "active";
  return conn.testStatus || "untested";
}

const PROVIDER_OPTIONS = [
  "autoclaw", "kiro", "qoder", "grok-cli", "codebuddy",
  "baseten", "chatgpt", "outlook", "tokenharbor", "cloudflare-ai",
];

function AccountCard({ conn, busy, onToggle, onRemove, onRefresh, onSetRefreshToken, benefit, benefitLoading }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderIcon providerId={conn.provider} size={18} />
          <span className="truncate text-sm font-medium">{conn.name || conn.displayProvider || "—"}</span>
        </div>
        <Badge variant={getStatusVariant(conn)} size="sm">{getStatusLabel(conn)}</Badge>
      </div>
      <div className="mt-1 truncate font-mono text-xs text-zinc-400">
        {conn.email || conn.providerSpecificData?.userId || "—"}
      </div>
      <div className="mt-1 text-xs text-zinc-300">
        {benefitLoading && !benefit ? (
          <span className="text-zinc-500">checking benefit…</span>
        ) : (
          formatBenefit(benefit)
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-zinc-500">
        <span className="truncate">{conn.displayProvider || conn.provider}</span>
        <span>{formatTime(conn.lastRefreshAt || conn.updatedAt)}</span>
      </div>
      <div className="mt-1 text-xs">
        {conn.expiresAt ? (
          <span className={new Date(conn.expiresAt) < new Date() ? "text-red-400" : "text-zinc-500"}>
            exp {formatTime(conn.expiresAt)}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" variant={conn.isActive ? "default" : "primary"} onClick={() => onToggle(conn)} disabled={busy} className="flex-1">
          {conn.isActive ? "Deactivate" : "Activate"}
        </Button>
        <Button size="sm" variant="default" onClick={() => onRefresh(conn)} disabled={busy}>
          Refresh
        </Button>
        <Button size="sm" variant="default" onClick={() => onSetRefreshToken(conn)} disabled={busy}>
          Set RT
        </Button>
        <Button size="sm" variant="danger" onClick={() => onRemove(conn)} disabled={busy}>
          Delete
        </Button>
      </div>
    </div>
  );
}

export default function AccountPoolPage() {
  const [connections, setConnections] = useState([]);
  const [grouped, setGrouped] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [providerFilter, setProviderFilter] = useState("");
  const [search, setSearch] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importProvider, setImportProvider] = useState("");
  const [importText, setImportText] = useState("");
  const [importResult, setImportResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [benefits, setBenefits] = useState({});
  const [benefitsLoading, setBenefitsLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { conn, message }
  const [refreshTokenTarget, setRefreshTokenTarget] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [scheduleDirty, setScheduleDirty] = useState(false); // conn
  const [refreshTokenValue, setRefreshTokenValue] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/account-pool");
      const data = await readJsonResponse(res);
      setConnections(data.connections || []);
      setGrouped(data.grouped || {});
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load refresh schedule from settings
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings");
        const data = await readJsonResponse(res);
        setSchedule(data.refreshSchedule || { enabled: false, times: [], timezone: "Asia/Jakarta", provider: "grok-cli" });
      } catch (e) {
        /* non-fatal */
      }
    })();
  }, []);

  async function saveSchedule() {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshSchedule: schedule }),
      });
      await readJsonResponse(res);
      setScheduleDirty(false);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    load();
  }, [load]);

  // Fetch benefits (trial/credits) untuk akun yang punya usage handler
  useEffect(() => {
    if (!connections.length) return;
    const ids = connections
      .filter((c) => !isCompatibleProvider(c.provider))
      .map((c) => c.id);
    if (!ids.length) return;
    let cancelled = false;
    setBenefitsLoading(true);
    (async () => {
      try {
        const res = await fetch("/api/account-pool/benefits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        const data = await readJsonResponse(res);
        if (!cancelled && data?.benefits) setBenefits(data.benefits);
      } catch {
        // benefit fetch is best-effort — ignore
      } finally {
        if (!cancelled) setBenefitsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connections]);

  const isCompatibleProvider = (id) =>
    id.startsWith("openai-compatible-chat-") || id.startsWith("anthropic-compatible-");

  const providers = useMemo(() => {
    return Object.entries(grouped)
      .filter(([id]) => !isCompatibleProvider(id))
      .sort((a, b) => b[1].total - a[1].total);
  }, [grouped]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return connections.filter(
      (c) =>
        !isCompatibleProvider(c.provider) &&
        (!providerFilter || c.provider === providerFilter) &&
        (!q ||
          (c.email || "").toLowerCase().includes(q) ||
          (c.name || "").toLowerCase().includes(q))
    );
  }, [connections, search, providerFilter]);

  async function toggleActive(conn) {
    setBusy(true);
    try {
      const res = await fetch("/api/account-pool", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: conn.id, isActive: !conn.isActive }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeAccount(conn) {
    setDeleteConfirm({
      conn,
      message: `Delete account ${conn.email || conn.name || conn.displayProvider || "?"}? This cannot be undone.`,
    });
  }

  async function refreshAccount(conn) {
    setBusy(true);
    try {
      const res = await fetch("/api/account-pool/refresh", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: conn.id }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function doSetRefreshToken() {
    if (!refreshTokenTarget || !refreshTokenValue.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/account-pool", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: refreshTokenTarget.id, refreshToken: refreshTokenValue.trim() }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setRefreshTokenTarget(null);
      setRefreshTokenValue("");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!importProvider || !importText.trim()) return;
    setBusy(true);
    setImportResult(null);
    try {
      const lines = importText.split("\n").filter((l) => l.trim());
      const res = await fetch("/api/account-pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: importProvider, lines }),
      });
      const data = await readJsonResponse(res);
      setImportResult(data);
      if (!data.errors?.length) {
        setImportText("");
        setImportOpen(false);
        await load();
      }
    } catch (e) {
      setImportResult({ error: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">Account Pool</h1>
          <p className="text-sm text-zinc-400">
            All provider accounts harvested by automation — separate from automation jobs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-64">
            <ProxyStatusPanel compact />
          </div>
          <Button onClick={() => setImportOpen(true)}>Import Accounts</Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
          <button className="ml-2 underline" onClick={load}>Retry</button>
        </div>
      )}

      {/* Provider stats — horizontal scroll on mobile */}
      <div className="-mx-4 overflow-x-auto px-4 pb-1">
        <div className="flex min-w-max gap-2">
          <button
            onClick={() => setProviderFilter("")}
            className={`rounded-xl border px-4 py-2.5 text-left transition-colors ${
              providerFilter === ""
                ? "border-indigo-400 bg-indigo-500/10"
                : "border-white/10 bg-white/5 hover:bg-white/10"
            }`}
          >
            <span className="text-sm font-medium text-white">All</span>
            <div className="text-xs text-zinc-400">
              {Object.entries(grouped)
                .filter(([id]) => !isCompatibleProvider(id))
                .reduce((s, [, g]) => s + g.total, 0)} accounts
            </div>
          </button>
          {providers.map(([provider, stats]) => (
            <button
              key={provider}
              onClick={() => setProviderFilter(providerFilter === provider ? "" : provider)}
              className={`rounded-xl border px-4 py-2.5 text-left transition-colors ${
                providerFilter === provider
                  ? "border-indigo-400 bg-indigo-500/10"
                  : "border-white/10 bg-white/5 hover:bg-white/10"
              }`}
            >
              <div className="flex items-center gap-2">
                <ProviderIcon providerId={provider} size={18} />
                <span className="text-sm font-medium capitalize text-white">{provider}</span>
              </div>
              <div className="text-xs text-zinc-400">
                {stats.active} active · {stats.total} total
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search email / name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <span className="text-sm text-zinc-500">{filtered.length} accounts</span>
      </div>

      {/* Scheduled refresh panel */}
      {schedule && (
        <div className="rounded-xl border border-indigo-400/30 bg-indigo-500/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-white">Scheduled Refresh</h2>
              <p className="text-xs text-zinc-400">
                Otomatis refresh semua akun {schedule.provider || "grok-cli"} di jam yang di-set.
                Auto-refresh bawaan (5 menit, sebelum expiry) tetap jalan — ini sweep tambahan.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setSchedule({ ...schedule, enabled: !schedule.enabled });
                  setScheduleDirty(true);
                }}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                  schedule.enabled
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "bg-white/10 text-zinc-300"
                }`}
              >
                {schedule.enabled ? "ON" : "OFF"}
              </button>
              <Button size="sm" onClick={saveSchedule} disabled={!scheduleDirty}>
                Save
              </Button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              placeholder="HH:MM (mis. 03:00)"
              value={(schedule.times || []).join(",")}
              onChange={(e) => {
                const times = e.target.value
                  .split(",")
                  .map((t) => t.trim())
                  .filter((t) => /^\d{2}:\d{2}$/.test(t));
                setSchedule({ ...schedule, times });
                setScheduleDirty(true);
              }}
              className="w-48"
            />
            <select
              value={schedule.timezone || "Asia/Jakarta"}
              onChange={(e) => {
                setSchedule({ ...schedule, timezone: e.target.value });
                setScheduleDirty(true);
              }}
              className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white"
            >
              <option value="Asia/Jakarta">Asia/Jakarta (WIB)</option>
              <option value="UTC">UTC</option>
              <option value="Asia/Singapore">Asia/Singapore</option>
              <option value="America/New_York">America/New_York</option>
            </select>
            <select
              value={schedule.provider || "grok-cli"}
              onChange={(e) => {
                setSchedule({ ...schedule, provider: e.target.value });
                setScheduleDirty(true);
              }}
              className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white"
            >
              <option value="grok-cli">grok-cli</option>
              <option value="xai">xai</option>
            </select>
            <span className="text-xs text-zinc-500">
              {schedule.enabled && schedule.times?.length
                ? `Akan refresh ${schedule.times.length}×/hari: ${schedule.times.join(", ")} (${schedule.timezone})`
                : "Set jam dulu (format HH:MM, pisahkan koma)"}
            </span>
          </div>
        </div>
      )}

      {/* Desktop table / mobile cards */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-white/5" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center">
          <div className="text-sm text-zinc-400">No accounts yet.</div>
          <div className="mt-1 text-xs text-zinc-500">
            Run an automation job or import accounts manually.
          </div>
          <Button className="mt-3" onClick={() => setImportOpen(true)}>Import Accounts</Button>
        </div>
      ) : (
        <>
          {/* Desktop table — hidden on mobile */}
          <div className="hidden overflow-hidden rounded-lg border border-white/10 md:block">
            <table className="w-full text-sm">
              <thead className="bg-white/5 text-left text-xs uppercase tracking-wide text-zinc-400">
                <tr>
                  <th scope="col" className="px-3 py-2.5 font-medium">Provider</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Name</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Email / ID</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Benefit</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Balance</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Last Refresh</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Expires</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-t border-white/5 transition-colors hover:bg-white/5">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <ProviderIcon providerId={c.provider} size={16} />
                        <span className="capitalize">{c.displayProvider || c.provider}</span>
                      </div>
                    </td>
                    <td className="max-w-[160px] truncate px-3 py-2.5">{c.name || "—"}</td>
                    <td className="max-w-[200px] truncate px-3 py-2.5 font-mono text-xs text-zinc-400">
                      {c.email || c.providerSpecificData?.userId || "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant={getStatusVariant(c)} size="sm">{getStatusLabel(c)}</Badge>
                    </td>
                    <td className="max-w-[220px] px-3 py-2.5 text-xs text-zinc-300">
                      {benefitsLoading && !benefits[c.id] ? (
                        <span className="text-zinc-500">checking…</span>
                      ) : (
                        formatBenefit(benefits[c.id])
                      )}
                    </td>
                    <td className="px-3 py-2.5">{c.balance != null ? c.balance : c.balanceError || "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-zinc-500">{formatTime(c.lastRefreshAt || c.updatedAt)}</td>
                    <td className="px-3 py-2.5 text-xs">
                      {c.expiresAt ? (
                        <span className={new Date(c.expiresAt) < new Date() ? "text-red-400" : "text-zinc-500"}>
                          {formatTime(c.expiresAt)}
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant={c.isActive ? "default" : "primary"} onClick={() => toggleActive(c)} disabled={busy}>
                          {c.isActive ? "Deactivate" : "Activate"}
                        </Button>
                        <Button size="sm" variant="default" onClick={() => refreshAccount(c)} disabled={busy}>
                          Refresh
                        </Button>
                        <Button size="sm" variant="default" onClick={() => { setRefreshTokenTarget(c); setRefreshTokenValue(""); }} disabled={busy}>
                          Set RT
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => removeAccount(c)} disabled={busy}>
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards — shown below md */}
          <div className="grid gap-2 sm:grid-cols-2 md:hidden">
            {filtered.map((c) => (
              <AccountCard
                key={c.id}
                conn={c}
                busy={busy}
                benefit={benefits[c.id]}
                benefitLoading={benefitsLoading}
                onToggle={toggleActive}
                onRemove={removeAccount}
                onRefresh={refreshAccount}
                onSetRefreshToken={(conn) => { setRefreshTokenTarget(conn); setRefreshTokenValue(""); }}
              />
            ))}
          </div>
        </>
      )}

      {/* Delete confirmation modal */}
      <ConfirmModal
        isOpen={!!deleteConfirm}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={async () => {
          const conn = deleteConfirm?.conn;
          if (!conn) return;
          setDeleteConfirm(null);
          setBusy(true);
          try {
            const res = await fetch(`/api/account-pool?id=${encodeURIComponent(conn.id)}`, { method: "DELETE" });
            const data = await readJsonResponse(res);
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            await load();
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
        title="Delete Account"
        message={deleteConfirm?.message}
        confirmText="Delete"
        variant="danger"
      />

      {/* Set refresh token modal */}
      <Modal isOpen={!!refreshTokenTarget} onClose={() => setRefreshTokenTarget(null)} title="Set Refresh Token">
        <div className="space-y-3">
          <p className="text-xs text-zinc-400">
            Account: <span className="font-mono text-zinc-300">{refreshTokenTarget?.email || refreshTokenTarget?.name || "—"}</span>
          </p>
          <div>
            <label htmlFor="pool-rt-value" className="mb-1 block text-xs text-zinc-400">
              Refresh Token
            </label>
            <textarea
              id="pool-rt-value"
              value={refreshTokenValue}
              onChange={(e) => setRefreshTokenValue(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              placeholder="paste refresh token…"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="default" onClick={() => setRefreshTokenTarget(null)}>Cancel</Button>
            <Button onClick={doSetRefreshToken} disabled={busy || !refreshTokenValue.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Import modal */}
      <Modal isOpen={importOpen} onClose={() => setImportOpen(false)} title="Import Accounts">
        <div className="space-y-3">
          <div>
            <label htmlFor="pool-import-provider" className="mb-1 block text-xs text-zinc-400">
              Provider
            </label>
            <select
              id="pool-import-provider"
              value={importProvider}
              onChange={(e) => setImportProvider(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            >
              <option value="">Select provider…</option>
              {PROVIDER_OPTIONS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="pool-import-text" className="mb-1 block text-xs text-zinc-400">
              Tokens (one per line — token, or email|token, or email:token)
            </label>
            <textarea
              id="pool-import-text"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={8}
              className="w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              placeholder={"token1\nuser@example.com|token2"}
            />
          </div>
          {importResult && (
            <div className="rounded-md bg-white/5 px-3 py-2 text-xs text-zinc-300">
              {importResult.error
                ? `Error: ${importResult.error}`
                : `Imported ${importResult.created} accounts${importResult.errors?.length ? `, ${importResult.errors.length} failed` : ""}`}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="default" onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button onClick={doImport} disabled={busy || !importProvider || !importText.trim()}>
              {busy ? "Importing…" : "Import"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
