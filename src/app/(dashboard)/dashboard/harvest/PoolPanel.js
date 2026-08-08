"use client";

import { useEffect, useState } from "react";

export default function PoolPanel({ api }) {
  const [health, setHealth] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [keys, setKeys] = useState([]);
  const [stats, setStats] = useState(null);
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [qoderInfo, setQoderInfo] = useState(null);

  async function refresh() {
    try {
      const [h, acc, k, s] = await Promise.all([
        api("GET", "/api/pool/health").catch(() => null),
        api("GET", "/api/pool/accounts").catch(() => ({ accounts: [] })),
        api("GET", "/api/pool/keys").catch(() => ({ keys: [] })),
        api("GET", "/api/pool/stats").catch(() => null),
      ]);
      setHealth(h);
      setAccounts(acc?.accounts || []);
      setKeys(k?.keys || []);
      setStats(s);
      if (s?.qoderTokens !== undefined) {
        setQoderInfo({ tokens: s.qoderTokens, lastRefresh: s.qoderLastRefresh });
      }
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doScan() {
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/pool/scan", {});
      refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    setBusy(true);
    setError(null);
    try {
      const lines = importText.split("\n").map((l) => l.trim()).filter(Boolean);
      await api("POST", "/api/pool/import", { lines });
      setImportText("");
      refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount(email) {
    if (!confirm(`Delete ${email}?`)) return;
    try {
      await api("DELETE", `/api/pool/accounts/${encodeURIComponent(email)}`, {});
      refresh();
    } catch (e) {
      setError(e.message);
    }
  }

  async function deleteKey(secret) {
    if (!confirm("Delete this key?")) return;
    try {
      await api("DELETE", `/api/pool/keys/${encodeURIComponent(secret)}`, {});
      refresh();
    } catch (e) {
      setError(e.message);
    }
  }

  const groupByKind = (list) =>
    list.reduce((m, a) => {
      const kind = a.kind || "other";
      (m[kind] = m[kind] || []).push(a);
      return m;
    }, {});

  const grouped = groupByKind(accounts);

  return (
    <div className="harvest-panel">
      {error && <div className="harvest-error">{error}</div>}

      <div className="harvest-card">
        <h3>Pool Health</h3>
        {health ? (
          <div className="harvest-row">
            {health.providers?.map((p) => (
              <span key={p.name || p} className={`harvest-pill ${p.ok ? "ok" : "bad"}`}>
                {p.name || p}
              </span>
            ))}
            {health.providers === undefined && (
              <span className="harvest-pill ok">gateway {health.ok ? "up" : "down"}</span>
            )}
          </div>
        ) : (
          <span className="harvest-pill bad">gateway unreachable</span>
        )}
        <div className="harvest-row">
          <button className="harvest-btn" onClick={doScan} disabled={busy}>Scan Accounts</button>
          <button className="harvest-btn" onClick={refresh} disabled={busy}>Refresh</button>
        </div>
      </div>

      <div className="harvest-card">
        <h3>Import Accounts</h3>
        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder={"one account per line\nemail:password:token:kind"}
          rows={4}
          className="harvest-textarea"
        />
        <div className="harvest-row">
          <button className="harvest-btn primary" onClick={doImport} disabled={busy || !importText.trim()}>
            Import
          </button>
        </div>
      </div>

      {qoderInfo && (
        <div className="harvest-card">
          <h3>Qoder</h3>
          <div className="harvest-row">
            <span className="harvest-pill ok">tokens: {qoderInfo.tokens}</span>
            <span className="harvest-pill">refresh: {qoderInfo.lastRefresh || "never"}</span>
          </div>
        </div>
      )}

      <div className="harvest-card">
        <h3>Accounts ({accounts.length})</h3>
        {Object.entries(grouped).map(([kind, list]) => (
          <div key={kind}>
            <h4 className="harvest-kind">{kind} ({list.length})</h4>
            <table className="harvest-table">
              <thead>
                <tr><th>Email</th><th>Status</th><th>Quota</th><th></th></tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <tr key={a.email || a.id}>
                    <td>{a.email || a.id}</td>
                    <td>{a.status || a.error || ""}</td>
                    <td>{a.quota != null ? `${a.quota}%` : ""}</td>
                    <td>
                      <button className="harvest-btn danger sm" onClick={() => deleteAccount(a.email)}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {accounts.length === 0 && <div className="harvest-empty">No accounts. Run scan or import.</div>}
      </div>

      <div className="harvest-card">
        <h3>Keys ({keys.length})</h3>
        {keys.length > 0 && (
          <table className="harvest-table">
            <thead>
              <tr><th>Name</th><th>Secret</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.secret || k.id}>
                  <td>{k.name || ""}</td>
                  <td className="harvest-mono">{(k.secret || "").slice(0, 12)}…</td>
                  <td>{k.status || k.error || ""}</td>
                  <td>
                    <button className="harvest-btn danger sm" onClick={() => deleteKey(k.secret)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {keys.length === 0 && <div className="harvest-empty">No keys.</div>}
      </div>
    </div>
  );
}
