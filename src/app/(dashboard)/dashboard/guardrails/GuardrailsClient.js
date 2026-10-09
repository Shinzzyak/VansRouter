"use client";

import { useCallback, useEffect, useState } from "react";

const ACTION_LABELS = {
  allow: "Allow (off)",
  log_only: "Log only",
  warn: "Warn",
  mask: "Mask",
  block: "Block",
};

const SCOPE_LABELS = {
  apikey: "API key",
  model: "Model",
  provider: "Provider",
  global: "Global",
};

const SEVERITY_CLASS = {
  high: "text-red-500",
  medium: "text-yellow-500",
  low: "text-text-muted",
};

const EMPTY_DRAFT = { scope: "global", scopeId: "", detectors: [], action: "log_only", enabled: true };

export default function GuardrailsClient() {
  const [vocab, setVocab] = useState({ scopes: [], detectors: [], actions: [] });
  const [policies, setPolicies] = useState([]);
  const [logs, setLogs] = useState([]);
  const [keys, setKeys] = useState([]);
  const [providers, setProviders] = useState([]);
  const [switchOn, setSwitchOn] = useState(true);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [policiesRes, logsRes, keysRes, providersRes, settingsRes] = await Promise.all([
        fetch("/api/guardrails/policies"),
        fetch("/api/guardrails/logs?limit=100"),
        fetch("/api/keys"),
        fetch("/api/providers"),
        fetch("/api/settings"),
      ]);
      if (policiesRes.ok) {
        const d = await policiesRes.json();
        setPolicies(d.policies || []);
        setVocab({ scopes: d.scopes || [], detectors: d.detectors || [], actions: d.actions || [] });
      }
      if (logsRes.ok) {
        const d = await logsRes.json();
        setLogs(d.logs || []);
      }
      if (keysRes.ok) {
        const d = await keysRes.json();
        setKeys(d.keys || []);
      }
      if (providersRes.ok) {
        const d = await providersRes.json();
        setProviders(d.connections || []);
      }
      if (settingsRes.ok) {
        const d = await settingsRes.json();
        setSwitchOn(d.guardrailsEnabled !== false);
      }
    } catch {
      /* the page renders empty rather than failing the route */
    }
  }, []);

  useEffect(() => {
    // Intentional initial synchronization with the policy store and audit log.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const scopeTargets = (scope) => {
    if (scope === "apikey") return keys.map((k) => ({ id: k.id, label: k.name || k.id }));
    if (scope === "provider") return providers.map((c) => ({ id: c.provider || c.id, label: c.name || c.provider || c.id }));
    if (scope === "model") {
      const seen = new Map();
      for (const c of providers) {
        for (const m of c.models || []) seen.set(m, m);
      }
      return [...seen.keys()].map((m) => ({ id: m, label: m }));
    }
    return [];
  };

  const toggleSwitch = async () => {
    const next = !switchOn;
    setSwitchOn(next);
    setBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guardrailsEnabled: next }),
      });
      if (!res.ok) setSwitchOn(!next);
    } catch {
      setSwitchOn(!next);
    } finally {
      setBusy(false);
    }
  };

  const toggleDetector = (name) => {
    setDraft((d) => ({
      ...d,
      detectors: d.detectors.includes(name) ? d.detectors.filter((x) => x !== name) : [...d.detectors, name],
    }));
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const url = editingId ? `/api/guardrails/policies/${editingId}` : "/api/guardrails/policies";
      const res = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: draft.scope,
          scopeId: draft.scope === "global" ? "" : draft.scopeId,
          detectors: draft.detectors,
          action: draft.action,
          enabled: draft.enabled,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || `Request failed (${res.status})`);
        return;
      }
      setDraft(EMPTY_DRAFT);
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const editPolicy = (p) => {
    setEditingId(p.id);
    setDraft({ scope: p.scope, scopeId: p.scopeId || "", detectors: p.detectors || [], action: p.action, enabled: p.enabled !== false });
  };

  const removePolicy = async (id) => {
    setBusy(true);
    try {
      await fetch(`/api/guardrails/policies/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (p) => {
    setBusy(true);
    try {
      await fetch(`/api/guardrails/policies/${p.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !(p.enabled !== false) }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const targets = scopeTargets(draft.scope);

  return (
    <div className="flex w-full flex-col gap-6">
      {/* Kill switch */}
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-bg-subtle p-4">
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined text-[20px] text-primary mt-0.5">shield</span>
          <div>
            <p className="text-sm font-medium text-text-main">Guardrails</p>
            <p className="text-xs text-text-muted leading-relaxed mt-0.5">
              Inspect requests before they reach the provider and replies before they reach the client.
              Off by default: nothing runs until a policy below exists. The switch stops both taps without
              deleting any policy, so the configuration and the audit trail survive.
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={switchOn}
          aria-label="Guardrails enabled"
          disabled={busy}
          onClick={toggleSwitch}
          className={`relative h-5 w-10 shrink-0 rounded-full transition disabled:opacity-50 ${switchOn ? "bg-primary" : "bg-border"}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${switchOn ? "left-5" : "left-0.5"}`}
          />
        </button>
      </div>

      {/* Policy editor */}
      <div className="rounded-lg border border-border bg-bg-subtle p-4">
        <p className="text-sm font-medium text-text-main mb-3">{editingId ? "Edit policy" : "New policy"}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Scope
            <select
              value={draft.scope}
              onChange={(e) => setDraft({ ...draft, scope: e.target.value, scopeId: "" })}
              className="rounded border border-border bg-bg px-2 py-1.5 text-sm text-text-main"
            >
              {vocab.scopes.map((s) => (
                <option key={s} value={s}>{SCOPE_LABELS[s] || s}</option>
              ))}
            </select>
          </label>

          {draft.scope !== "global" && (
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              Applies to
              <select
                value={draft.scopeId}
                onChange={(e) => setDraft({ ...draft, scopeId: e.target.value })}
                className="rounded border border-border bg-bg px-2 py-1.5 text-sm text-text-main"
              >
                <option value="">Select…</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Action
            <select
              value={draft.action}
              onChange={(e) => setDraft({ ...draft, action: e.target.value })}
              className="rounded border border-border bg-bg px-2 py-1.5 text-sm text-text-main"
            >
              {vocab.actions.map((a) => (
                <option key={a} value={a}>{ACTION_LABELS[a] || a}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-3">
          <p className="text-xs text-text-muted mb-2">Detectors</p>
          <div className="flex flex-wrap gap-2">
            {vocab.detectors.map((name) => {
              const on = draft.detectors.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => toggleDetector(name)}
                  className={`rounded-full border px-3 py-1 text-xs transition ${on ? "border-primary bg-primary/10 text-primary" : "border-border text-text-muted"}`}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={busy || !draft.detectors.length || (draft.scope !== "global" && !draft.scopeId)}
            onClick={submit}
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            {editingId ? "Save" : "Add policy"}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={() => { setEditingId(null); setDraft(EMPTY_DRAFT); setError(null); }}
              className="rounded border border-border px-3 py-1.5 text-xs text-text-muted"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Policies */}
      <div className="rounded-lg border border-border bg-bg-subtle p-4">
        <p className="text-sm font-medium text-text-main mb-3">Policies</p>
        {!policies.length ? (
          <p className="text-xs text-text-muted">No policy configured. Requests and replies pass through untouched.</p>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {policies.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-text-main truncate">
                    {SCOPE_LABELS[p.scope] || p.scope}
                    {p.scopeId ? ` · ${p.scopeId}` : ""}
                  </p>
                  <p className="text-xs text-text-muted truncate">
                    {(p.detectors || []).join(", ") || "no detectors"} → {ACTION_LABELS[p.action] || p.action}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleEnabled(p)}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${p.enabled !== false ? "border-primary text-primary" : "border-border text-text-muted"}`}
                  >
                    {p.enabled !== false ? "enabled" : "disabled"}
                  </button>
                  <button type="button" onClick={() => editPolicy(p)} className="text-xs text-text-muted hover:text-text-main">edit</button>
                  <button type="button" onClick={() => removePolicy(p.id)} className="text-xs text-red-500 hover:opacity-80">delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Audit log */}
      <div className="rounded-lg border border-border bg-bg-subtle p-4">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-medium text-text-main">Recent firings</p>
          <button type="button" onClick={load} className="text-xs text-text-muted hover:text-text-main">refresh</button>
        </div>
        {!logs.length ? (
          <p className="text-xs text-text-muted">Nothing fired yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-text-muted">
                <tr>
                  <th className="py-1 pr-3 font-normal">Time</th>
                  <th className="py-1 pr-3 font-normal">Dir</th>
                  <th className="py-1 pr-3 font-normal">Action</th>
                  <th className="py-1 pr-3 font-normal">Detector</th>
                  <th className="py-1 pr-3 font-normal">Scope</th>
                  <th className="py-1 pr-3 font-normal">Model</th>
                  <th className="py-1 font-normal">Severity</th>
                </tr>
              </thead>
              <tbody className="text-text-main">
                {logs.map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <td className="py-1 pr-3 whitespace-nowrap">{new Date(l.ts).toLocaleString()}</td>
                    <td className="py-1 pr-3">{l.direction}</td>
                    <td className="py-1 pr-3">{l.action}</td>
                    <td className="py-1 pr-3">{l.detector}</td>
                    <td className="py-1 pr-3">{l.scope || "—"}</td>
                    <td className="py-1 pr-3 max-w-[180px] truncate">{l.model || "—"}</td>
                    <td className={`py-1 ${SEVERITY_CLASS[l.severity] || ""}`}>{l.severity || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-text-muted">
          Matched text is never stored — only the detector, the span offsets and the severity.
        </p>
      </div>
    </div>
  );
}
