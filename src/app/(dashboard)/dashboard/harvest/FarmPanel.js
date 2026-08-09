"use client";

import { useEffect, useState } from "react";

const PROVIDERS = [
  "codebuddy",
  "tokengo",
  "github",
  "cloudflare-signup",
  "qoder",
  "baseten",
  "proxy",
];

export default function FarmPanel({ api, events, clearEvents }) {
  const [provider, setProvider] = useState("codebuddy");
  const [count, setCount] = useState(1);
  const [accounts, setAccounts] = useState([]);
  const [proxies, setProxies] = useState([]);
  const [status, setStatus] = useState(null);
  const [sys, setSys] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      const [acc, px, st, mem] = await Promise.all([
        api("GET", "/api/harvest-proxy/accounts").catch(() => ({ accounts: [] })),
        api("GET", "/api/harvest-proxy/proxies").catch(() => ({ proxies: [] })),
        api("GET", "/api/harvest-proxy/harvest/status").catch(() => null),
        api("GET", "/api/harvest-proxy/system/mem").catch(() => null),
      ]);
      setAccounts(acc?.accounts || acc || []);
      setProxies(px?.proxies || px || []);
      setStatus(st);
      setSys(mem);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startHarvest() {
    setBusy(true);
    setError(null);
    try {
      const res = await api("POST", "/api/harvest-proxy/harvest/start", { provider, count });
      setStatus(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function stopHarvest() {
    setBusy(true);
    try {
      await api("POST", "/api/harvest-proxy/harvest/stop", {});
      setStatus(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function deleteAccount(email) {
    if (!confirm(`Delete account ${email}?`)) return;
    try {
      await api("DELETE", `/api/harvest-proxy/accounts/${encodeURIComponent(email)}`, {});
      refresh();
    } catch (e) {
      setError(e.message);
    }
  }

  async function clearAccounts() {
    if (!confirm("Clear ALL accounts?")) return;
    try {
      await api("DELETE", "/api/harvest-proxy/accounts", {});
      refresh();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="harvest-panel">
      {error && <div className="harvest-error">{error}</div>}

      <div className="harvest-card">
        <h3>Start Harvest</h3>
        <div className="harvest-row">
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            value={count}
            onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
            style={{ width: 80 }}
          />
          <button className="harvest-btn primary" onClick={startHarvest} disabled={busy}>
            {busy ? "Starting…" : "Start"}
          </button>
          <button className="harvest-btn danger" onClick={stopHarvest} disabled={busy || !status}>
            Stop
          </button>
        </div>
        {status && (
          <div className="harvest-status">
            <pre>{JSON.stringify(status, null, 2)}</pre>
          </div>
        )}
        {sys && (
          <div className="harvest-sys">
            RAM {sys.ram?.usedGb ?? "?"}G / {sys.ram?.totalGb ?? "?"}G · CPU {sys.cpu ?? "?"}%
          </div>
        )}
      </div>

      <div className="harvest-card">
        <div className="harvest-card-head">
          <h3>Accounts ({accounts.length})</h3>
          <button className="harvest-btn danger" onClick={clearAccounts}>Clear All</button>
        </div>
        {accounts.length > 0 && (
          <table className="harvest-table">
            <thead>
              <tr><th>Email</th><th>Provider</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.email || a.id}>
                  <td data-label="Email">{a.email || a.id}</td>
                  <td data-label="Provider">{a.provider || a.kind || ""}</td>
                  <td data-label="Status">{a.status || a.error || ""}</td>
                  <td data-label="">
                    <button className="harvest-btn danger sm" onClick={() => deleteAccount(a.email)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {accounts.length === 0 && <div className="harvest-empty">No accounts yet — start a harvest above.</div>}
      </div>

      <div className="harvest-card">
        <h3>Live Console</h3>
        <div className="harvest-console">
          {events.length === 0 && <div className="harvest-console-empty">Waiting for events…</div>}
          {events.map((e, i) => (
            <div key={i} className={`harvest-line ${e.type}`}>
              <span className="harvest-line-type">{e.type}</span> {e.data}
            </div>
          ))}
        </div>
        <button className="harvest-btn sm" onClick={clearEvents}>Clear</button>
      </div>
    </div>
  );
}
