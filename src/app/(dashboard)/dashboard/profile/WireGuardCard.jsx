"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Toggle } from "@/shared/components";

function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// WireGuard global-egress card (v1). Brings up a profile from /etc/wireguard as
// the router's full-tunnel egress next to the HTTP outbound proxy option.
export default function WireGuardCard() {
  const [status, setStatus] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [profileName, setProfileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState({ type: "", text: "" });

  const [showImport, setShowImport] = useState(false);
  const [importName, setImportName] = useState("");
  const [importConf, setImportConf] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState({ type: "", text: "" });

  const refresh = useCallback(async () => {
    try {
      const [sRes, pRes] = await Promise.all([
        fetch("/api/tunnel/wireguard-status"),
        fetch("/api/tunnel/wireguard-profiles"),
      ]);
      const s = await sRes.json();
      const p = await pRes.json();
      setStatus(s);
      setProfiles(p.profiles || []);
      if (s?.settingsEnabled && s.profileName) setProfileName(s.profileName);
    } catch {
      setMsg({ type: "error", text: "Failed to load WireGuard status." });
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- single refresh on mount, controlled by the button elsewhere */
  useEffect(() => {
    refresh();
  }, [refresh]);

  const enable = async () => {
    if (!profileName) {
      setMsg({ type: "error", text: "Select a config from /etc/wireguard first." });
      return;
    }
    setLoading(true);
    setMsg({ type: "", text: "" });
    try {
      const res = await fetch("/api/tunnel/wireguard-enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Enable failed");
      setMsg({ type: "success", text: `WireGuard up via ${data.endpoint}` });
      await refresh();
    } catch (err) {
      setMsg({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const disable = async () => {
    setLoading(true);
    setMsg({ type: "", text: "" });
    try {
      const res = await fetch("/api/tunnel/wireguard-disable", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Disable failed");
      setMsg({ type: "success", text: "WireGuard down — egress back to default route." });
      await refresh();
    } catch (err) {
      setMsg({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const submitImport = async () => {
    if (!importName.trim() || !importConf.trim()) {
      setImportMsg({ type: "error", text: "Name and config body are required." });
      return;
    }
    setImporting(true);
    setImportMsg({ type: "", text: "" });
    try {
      const res = await fetch("/api/tunnel/wireguard-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: importName.trim(), conf: importConf }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      setImportMsg({
        type: "success",
        text: `Imported ${data.name} — ${data.endpoint || "no endpoint"}, ${data.peerCount} peer(s).`,
      });
      setImportName("");
      setImportConf("");
      setShowImport(false);
      await refresh();
      setMsg({ type: "success", text: `Profile ${data.name} ready — pick it above and Connect.` });
    } catch (err) {
      setImportMsg({ type: "error", text: err.message });
    } finally {
      setImporting(false);
    }
  };

  const up = status?.up === true;
  const iface = status?.iface;

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-purple-500/10 text-purple-500 shrink-0">
          <span className="material-symbols-outlined text-[20px]">lan</span>
        </div>
        <h3 className="text-base sm:text-lg font-semibold">WireGuard Egress</h3>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-start sm:items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm sm:text-base">Global tunnel egress</p>
            <p className="text-xs sm:text-sm text-text-muted">
              Bring up a /etc/wireguard profile so all router outbound traffic exits the VPN.
            </p>
          </div>
          <Toggle checked={up} onChange={up ? disable : enable} disabled={loading} />
        </div>

        {!up && (
          <div className="flex flex-col gap-2 pt-2 border-t border-border/50">
            <select
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              disabled={loading}
              className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-50"
            >
              <option value="">{profiles.length === 0 ? "No profiles in /etc/wireguard" : "Select profile…"}</option>
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} {p.endpoint ? `(${p.endpoint})` : ""}
                </option>
              ))}
            </select>
            <p className="text-xs sm:text-sm text-text-muted">
              Drop <code className="text-text-muted border border-border/50 rounded px-1">wg0.conf</code> from your VPN provider
              into <code className="text-text-muted border border-border/50 rounded px-1">/etc/wireguard/</code>, or import it here.
            </p>
            <div className="pt-1 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <Button onClick={refresh} variant="secondary" disabled={loading} className="w-full sm:w-auto">
                Refresh
              </Button>
              <Button onClick={() => setShowImport((v) => !v)} variant="secondary" disabled={loading} className="w-full sm:w-auto">
                {showImport ? "Hide import" : "Import .conf"}
              </Button>
              <Button onClick={enable} variant="primary" loading={loading} disabled={!profileName} className="w-full sm:w-auto">
                Connect
              </Button>
            </div>
            {showImport && (
              <div className="flex flex-col gap-2 pt-2 border-t border-border/50">
                <input
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                  placeholder="Profile name (e.g. provider-sg)"
                  disabled={importing}
                  className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-50"
                />
                <textarea
                  value={importConf}
                  onChange={(e) => setImportConf(e.target.value)}
                  placeholder="[Interface]&#10;PrivateKey = …&#10;Address = 10.7.0.2/32&#10;&#10;[Peer]&#10;PublicKey = …&#10;Endpoint = vpn.example.com:51820&#10;AllowedIPs = 0.0.0.0/0"
                  rows={7}
                  disabled={importing}
                  className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-xs font-mono disabled:opacity-50"
                />
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <Button
                    onClick={submitImport}
                    loading={importing}
                    disabled={!importName.trim() || !importConf.trim()}
                    className="w-full sm:w-auto"
                  >
                    Import
                  </Button>
                  <Button
                    onClick={() => {
                      setShowImport(false);
                      setImportMsg({ type: "", text: "" });
                    }}
                    variant="secondary"
                    disabled={importing}
                    className="w-full sm:w-auto"
                  >
                    Cancel
                  </Button>
                </div>
                {importMsg.text && (
                  <p className={`text-xs sm:text-sm ${importMsg.type === "error" ? "text-red-500" : "text-green-500"}`}>
                    {importMsg.text}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {up && iface && (
          <div className="flex flex-col gap-1.5 pt-2 border-t border-border/50 text-xs sm:text-sm">
            <div className="flex justify-between gap-2">
              <span className="text-text-muted">Profile</span>
              <span className="font-medium">{status.profileName}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-text-muted">Endpoint</span>
              <span className="font-medium truncate">{iface.endpoint || status.conf?.endpoint || "—"}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-text-muted">Egress IP</span>
              <span className="font-medium">{status.egressIP || "…"}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-text-muted">Handshake</span>
              <span className="font-medium">{iface.handshake ? new Date(iface.handshake).toLocaleString() : "pending"}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-text-muted">Transfer</span>
              <span className="font-medium">
                ↓ {formatBytes(iface.rx)} · ↑ {formatBytes(iface.tx)}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-text-muted">Pubkey</span>
              <span className="font-medium truncate font-mono">{iface.publicKey?.slice(0, 24) || "—"}…</span>
            </div>
          </div>
        )}

        {msg.text && (
          <p
            className={`text-xs sm:text-sm ${
              msg.type === "error" ? "text-red-500" : "text-green-500"
            } pt-2 border-t border-border/50`}
          >
            {msg.text}
          </p>
        )}
      </div>
    </Card>
  );
}
