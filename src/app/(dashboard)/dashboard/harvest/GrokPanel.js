"use client";

import { useEffect, useState } from "react";

export default function GrokPanel({ api, events, clearEvents }) {
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      const [cfg, st, acc] = await Promise.all([
        api("GET", "/api/harvest-proxy/grok/config").catch(() => null),
        api("GET", "/api/harvest-proxy/grok/status").catch(() => null),
        api("GET", "/api/harvest-proxy/grok/accounts").catch(() => ({ accounts: [] })),
      ]);
      setConfig(cfg?.config || cfg);
      setStatus(st);
      setAccounts(acc?.accounts || acc || []);
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

  async function saveConfig() {
    setBusy(true);
    setError(null);
    try {
      const res = await api("POST", "/api/harvest-proxy/grok/config", config);
      setConfig(res?.config || res || config);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await api("POST", "/api/harvest-proxy/grok/start", {});
      setStatus(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await api("POST", "/api/harvest-proxy/grok/stop", {});
      setStatus(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      refresh();
    }
  }

  function setCfg(key, value) {
    setConfig((c) => ({ ...(c || {}), [key]: value }));
  }

  return (
    <div className="harvest-panel">
      {error && <div className="harvest-error">{error}</div>}

      <div className="harvest-card">
        <h3>Grok Config</h3>
        {config ? (
          <div className="harvest-config">
            {Object.entries(config).map(([key, value]) => {
              if (typeof value === "boolean") {
                return (
                  <label key={key} className="harvest-config-row">
                    <span>{key}</span>
                    <input
                      type="checkbox"
                      checked={value}
                      onChange={(e) => setCfg(key, e.target.checked)}
                    />
                  </label>
                );
              }
              if (typeof value === "number") {
                return (
                  <label key={key} className="harvest-config-row">
                    <span>{key}</span>
                    <input
                      type="number"
                      value={value}
                      onChange={(e) => setCfg(key, Number(e.target.value))}
                    />
                  </label>
                );
              }
              return (
                <label key={key} className="harvest-config-row">
                  <span>{key}</span>
                  <input
                    type="text"
                    value={value ?? ""}
                    onChange={(e) => setCfg(key, e.target.value)}
                  />
                </label>
              );
            })}
            <div className="harvest-row">
              <button className="harvest-btn primary" onClick={saveConfig} disabled={busy}>
                Save Config
              </button>
            </div>
          </div>
        ) : (
          <div className="harvest-empty">Config unavailable (harvest console offline?)</div>
        )}
      </div>

      <div className="harvest-card">
        <h3>Control</h3>
        <div className="harvest-row">
          <button className="harvest-btn primary" onClick={start} disabled={busy || status?.running}>
            {status?.running ? "Running…" : "Start"}
          </button>
          <button className="harvest-btn danger" onClick={stop} disabled={busy || !status?.running}>
            Stop
          </button>
          {status && <pre className="harvest-status">{JSON.stringify(status, null, 2)}</pre>}
        </div>
      </div>

      <div className="harvest-card">
        <h3>Accounts ({accounts.length})</h3>
        {accounts.length > 0 && (
          <table className="harvest-table">
            <thead>
              <tr><th>Email</th><th>Status</th></tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.email || a.id}>
                  <td>{a.email || a.id}</td>
                  <td>{a.status || a.error || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {accounts.length === 0 && <div className="harvest-empty">No grok accounts.</div>}
      </div>

      <div className="harvest-card">
        <h3>Grok Logs</h3>
        <div className="harvest-console">
          {events.length === 0 && <div className="harvest-console-empty">Waiting for grok events…</div>}
          {events.map((e, i) => (
            <div key={i} className="harvest-line grok">
              <span className="harvest-line-type">{e.type}</span> {e.data}
            </div>
          ))}
        </div>
        <button className="harvest-btn sm" onClick={clearEvents}>Clear</button>
      </div>
    </div>
  );
}
