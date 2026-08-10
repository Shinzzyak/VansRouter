"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import Modal from "@/shared/components/Modal";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { readJsonResponse } from "@/shared/utils/httpResponse.js";

function formatTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = providerFilter ? `?provider=${encodeURIComponent(providerFilter)}` : "";
      const res = await fetch(`/api/account-pool${q}`);
      const data = await readJsonResponse(res);
      setConnections(data.connections || []);
      setGrouped(data.grouped || {});
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [providerFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const providers = useMemo(() => {
    return Object.entries(grouped).sort((a, b) => b[1].total - a[1].total);
  }, [grouped]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return connections.filter(
      (c) =>
        !q ||
        (c.email || "").toLowerCase().includes(q) ||
        (c.name || "").toLowerCase().includes(q)
    );
  }, [connections, search]);

  async function toggleActive(conn) {
    setBusy(true);
    try {
      await fetch("/api/account-pool", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: conn.id, isActive: !conn.isActive }),
      });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeAccount(conn) {
    if (!confirm(`Delete account ${conn.email || conn.name}?`)) return;
    setBusy(true);
    try {
      await fetch(`/api/account-pool?id=${encodeURIComponent(conn.id)}`, { method: "DELETE" });
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Account Pool</h1>
          <p className="text-sm opacity-60">
            All provider accounts harvested by automation — separate from automation jobs.
          </p>
        </div>
        <Button onClick={() => setImportOpen(true)}>Import Accounts</Button>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>
      )}

      {/* Provider stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {providers.map(([provider, stats]) => (
          <button
            key={provider}
            onClick={() => setProviderFilter(providerFilter === provider ? "" : provider)}
            className={`rounded-xl border p-3 text-left transition ${
              providerFilter === provider
                ? "border-indigo-400 bg-indigo-500/10"
                : "border-white/10 bg-white/5 hover:bg-white/10"
            }`}
          >
            <div className="flex items-center gap-2">
              <ProviderIcon provider={provider} size={20} />
              <span className="font-medium capitalize">{provider}</span>
            </div>
            <div className="mt-1 text-xs opacity-60">
              {stats.active} active · {stats.total} total
            </div>
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search email / name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <span className="text-sm opacity-60">{filtered.length} accounts</span>
      </div>

      {/* Table */}
      <Card>
        {loading ? (
          <div className="p-6 text-center text-sm opacity-60">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-center text-sm opacity-60">
            No accounts yet. Run an automation job or import accounts manually.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left opacity-60">
                  <th className="p-2">Provider</th>
                  <th className="p-2">Name</th>
                  <th className="p-2">Email / ID</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Balance</th>
                  <th className="p-2">Last Refresh</th>
                  <th className="p-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-b border-white/5 hover:bg-white/5">
                    <td className="p-2">
                      <div className="flex items-center gap-1.5">
                        <ProviderIcon provider={c.provider} size={16} />
                        <span className="capitalize">{c.provider}</span>
                      </div>
                    </td>
                    <td className="p-2">{c.name || "—"}</td>
                    <td className="p-2 font-mono text-xs">{c.email || c.providerSpecificData?.userId || "—"}</td>
                    <td className="p-2">
                      <Badge variant={getStatusVariant(c)} size="sm">{getStatusLabel(c)}</Badge>
                    </td>
                    <td className="p-2">{c.balance != null ? c.balance : c.balanceError || "—"}</td>
                    <td className="p-2 text-xs opacity-60">{formatTime(c.lastRefreshAt || c.updatedAt)}</td>
                    <td className="p-2">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant={c.isActive ? "default" : "primary"} onClick={() => toggleActive(c)} disabled={busy}>
                          {c.isActive ? "Deactivate" : "Activate"}
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
        )}
      </Card>

      {/* Import modal */}
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Import Accounts">
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs opacity-60">Provider</label>
            <select
              value={importProvider}
              onChange={(e) => setImportProvider(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
            >
              <option value="">Select provider…</option>
              {providers.map(([p]) => (
                <option key={p} value={p}>{p}</option>
              ))}
              <option value="autoclaw">autoclaw</option>
              <option value="kiro">kiro</option>
              <option value="qoder">qoder</option>
              <option value="grok-cli">grok-cli</option>
              <option value="codebuddy">codebuddy</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs opacity-60">
              Tokens (one per line — token, or email|token, or email:token)
            </label>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={8}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs"
              placeholder={"token1\nuser@example.com|token2"}
            />
          </div>
          {importResult && (
            <div className="rounded-lg bg-white/5 px-3 py-2 text-xs">
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
