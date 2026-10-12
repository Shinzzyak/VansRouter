"use client";

import { useState } from "react";
import { Card, Button, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// The buyer's only screen. One field in, three facts out: the key, the address
// to call, and how much is left of what they paid for. No endpoint tour, no
// request/response documentation — a buyer needs an address and a secret.

function fmtQuota(tokens) {
  if (tokens === null || tokens === undefined) return "Tanpa batas token";
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)} juta token`;
  }
  return `${tokens.toLocaleString("id-ID")} token`;
}

function fmtDate(iso) {
  if (!iso) return "Tanpa batas waktu";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

function CopyRow({ label, value, copy, copied, id, mono = true }) {
  const done = copied === id;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</span>
      <div className="flex items-start gap-2">
        <code
          className={`flex-1 min-w-0 break-all rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-text-main ${mono ? "font-mono" : ""}`}
        >
          {value}
        </code>
        <Button variant="secondary" size="sm" className="shrink-0" onClick={() => copy(String(value), id)}>
          {done ? "Tersalin" : "Salin"}
        </Button>
      </div>
    </div>
  );
}

export default function TukarPage() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const { copy, copied } = useCopyToClipboard();

  const submit = async (event) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/v1/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || `Gagal menukar kode (HTTP ${res.status})`);
      setResult(data);
      setCode("");
    } catch (err) {
      setError(err.message || "Gagal menukar kode");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-bg px-4 py-10 flex items-start sm:items-center justify-center">
      <div className="w-full max-w-md flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-bold text-text-main">Tukar kode</h1>
          <p className="text-sm text-text-muted">Masukkan kode pembelian kamu untuk mendapatkan API key.</p>
        </div>

        {!result && (
          <Card padding="sm">
            <form onSubmit={submit} className="flex flex-col gap-3">
              <Input
                label="Kode"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="XXXX-XXXX-XXXX"
                inputClassName="font-mono tracking-[0.2em] text-center"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                required
              />
              <Button type="submit" fullWidth size="lg" loading={busy} disabled={!code.trim()}>
                Tukar kode
              </Button>
            </form>
          </Card>
        )}

        {error && (
          <div className="rounded-[10px] border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
            {error}
          </div>
        )}

        {result && (
          <Card padding="sm" className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-text-main">Key kamu siap</span>
              <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
                Tukar kode lain
              </Button>
            </div>

            <CopyRow label="API Key" value={result.api_key} copy={copy} copied={copied} id="api-key" />
            <CopyRow label="Base URL" value={result.base_url} copy={copy} copied={copied} id="base-url" />

            <div className="grid grid-cols-2 gap-3 border-t border-border-subtle pt-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs uppercase tracking-wide text-text-muted">Kuota</span>
                <span className="text-sm font-semibold text-text-main">{fmtQuota(result.tokens)}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs uppercase tracking-wide text-text-muted">Masa aktif</span>
                <span className="text-sm font-semibold text-text-main">{fmtDate(result.expires_at)}</span>
              </div>
            </div>

            <p className="text-xs text-text-muted">
              Simpan key ini sekarang. Setelah halaman ditutup, key tidak ditampilkan lagi.
            </p>
          </Card>
        )}
      </div>
    </main>
  );
}
