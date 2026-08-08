"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardSkeleton, Input, ConfirmModal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

export default function YydsPage() {
  const [loading, setLoading] = useState(true);
  const [domains, setDomains] = useState([]);
  const [settings, setSettings] = useState(null);
  const [inbox, setInbox] = useState(null); // { address, token }
  const [creating, setCreating] = useState(false);
  const [polling, setPolling] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const notify = useNotificationStore();

  const fetchAll = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([
        fetch("/api/yyds", { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
      ]);
      const dj = await d.json();
      setDomains(dj.ok ? dj.domains || [] : []);
      if (!dj.ok) setError(dj.error || "Failed to load YYDS domains");
      const sj = await s.json();
      setSettings(sj);
    } catch {
      setError("Failed to reach YYDS API");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAll();
  }, [fetchAll]);

  const createInbox = async () => {
    setCreating(true);
    setError("");
    try {
      const r = await fetch("/api/yyds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "create failed");
      setInbox(j);
      notify.success(`Inbox created: ${j.address}`);
    } catch (e) {
      setError(e.message);
      notify.error(e.message);
    } finally {
      setCreating(false);
    }
  };

  const pollOtp = async () => {
    if (!inbox) return;
    setPolling(true);
    setError("");
    try {
      const r = await fetch("/api/yyds/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: inbox.address, token: inbox.token, timeout: 120 }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "poll failed");
      setCode(j.code);
      notify.success(`OTP: ${j.code}`);
    } catch (e) {
      setError(e.message);
      notify.error(e.message);
    } finally {
      setPolling(false);
    }
  };

  const privateDomains = domains.filter((d) => !d.isPublic);
  const publicDomains = domains.filter((d) => d.isPublic);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
      {loading ? (
        <CardSkeleton />
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold sm:text-2xl">YYDS Temp Mail</h1>
                <Badge variant={settings?.yydsJwtConfigured ? "success" : "warning"}>
                  {settings?.yydsJwtConfigured ? "JWT configured" : "JWT missing"}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-gray-400">
                Temp-mail provider. Create a disposable inbox, then poll for a verification code.
              </p>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
          )}

          {!settings?.yydsJwtConfigured && (
            <Card>
              <div className="p-4 text-sm text-gray-300">
                <b className="text-amber-300">JWT belum dikonfigurasi.</b> Buat inbox butuh JWT akun YYDS (dari login{" "}
                <code className="rounded bg-black/30 px-1">mail.215.im</code>). Set <code className="rounded bg-black/30 px-1">YYDS_JWT</code>{" "}
                di <code className="rounded bg-black/30 px-1">.env</code> atau <code className="rounded bg-black/30 px-1">yydsJwt</code> di settings DB.
              </div>
            </Card>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <div className="p-4">
                <h2 className="mb-2 text-sm font-semibold text-gray-300">Create Inbox</h2>
                <p className="mb-3 text-xs text-gray-400">
                  Buat alamat temp-mail sekali pakai di domain terverifikasi YYDS (prefer owned).
                </p>
                <Button onClick={createInbox} disabled={creating || !settings?.yydsJwtConfigured}>
                  {creating ? "Creating…" : "Create Inbox"}
                </Button>
                {inbox && (
                  <div className="mt-3 rounded-lg bg-black/20 p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-emerald-300">{inbox.address}</span>
                      <button
                        type="button"
                        className="shrink-0 text-gray-400 hover:text-white"
                        onClick={() => navigator.clipboard?.writeText(inbox.address)}
                      >
                        copy
                      </button>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-gray-400">{inbox.token}</span>
                      <button
                        type="button"
                        className="shrink-0 text-gray-400 hover:text-white"
                        onClick={() => navigator.clipboard?.writeText(inbox.token)}
                      >
                        copy
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </Card>

            <Card>
              <div className="p-4">
                <h2 className="mb-2 text-sm font-semibold text-gray-300">Poll OTP</h2>
                <p className="mb-3 text-xs text-gray-400">
                  Tunggu email verifikasi ke inbox, ekstrak kode (poll 2 menit).
                </p>
                <Button onClick={pollOtp} disabled={polling || !inbox} variant={inbox ? "primary" : "secondary"}>
                  {polling ? "Polling…" : "Poll for Code"}
                </Button>
                {code && (
                  <div className="mt-3 rounded-lg bg-emerald-500/10 p-3 text-center">
                    <span className="font-mono text-2xl font-bold tracking-widest text-emerald-300">{code}</span>
                  </div>
                )}
              </div>
            </Card>
          </div>

          <Card>
            <div className="p-4">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold text-gray-300">Domains</h2>
                <Badge variant="default">{domains.length} total</Badge>
                <Badge variant="success">{privateDomains.length} private</Badge>
              </div>
              {domains.length === 0 ? (
                <p className="text-sm text-gray-500">No domains listed — check YYDS API key / JWT.</p>
              ) : (
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-[#0c0d12]">
                      <tr className="text-gray-500">
                        <th className="py-2 pr-2 font-medium">Domain</th>
                        <th className="px-2 py-2 font-medium">Verified</th>
                        <th className="px-2 py-2 font-medium">Public</th>
                        <th className="px-2 py-2 font-medium">MX</th>
                      </tr>
                    </thead>
                    <tbody>
                      {domains.map((d) => (
                        <tr key={d.domain} className="border-t border-white/5 text-gray-300">
                          <td className="py-1.5 pr-2 font-mono">{d.domain}</td>
                          <td className="px-2 py-1.5">{d.isVerified ? "✓" : "✗"}</td>
                          <td className="px-2 py-1.5">{d.isPublic ? "public" : <span className="text-amber-300">private</span>}</td>
                          <td className="px-2 py-1.5">{d.isMxValid ? "✓" : "✗"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
