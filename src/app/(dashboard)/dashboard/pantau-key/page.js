"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Button, Badge, CardSkeleton, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// Pantau Key — satu layar buat lihat sisa saldo tiap key resale.
//
// Sebuah key resale = key yang dibuat di halaman Resale: selalu dibawa ke
// `source = resell` dan biasanya membawa tokenBalance (jatah token). Saldonya
// menipis, beda dari key unlimited di endpoint. Halaman ini cuma MEMBACA —
// key tetap dikelola di Endpoint & Key / Resale.
//
// ponytail: manual-mint yang cuma bawa masa aktif (tanpa tokenBalance) punya
// tokenBalance null dan source resell; ditangkap filter via source, tapi tak
// ada saldo token untuk dipantau.

async function api(path) {
  const res = await fetch(path);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const message = data?.error?.message || data?.error || `HTTP ${res.status}`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return data;
}

// Sebuah key tergolong resale kalau dibuat di Resale (source resell) atau
// membawa saldo token.
function isResale(k) {
  return k.tokenBalance != null || k.source === "resell";
}

function remaining(k) {
  if (k.tokenBalance == null) return null;
  return Math.max(0, k.tokenBalance - (k.tokensSpent ?? 0));
}

function fmtTokens(tokens) {
  if (tokens === null || tokens === undefined) return "tanpa batas";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)} juta`;
  }
  return `${tokens.toLocaleString("id-ID")}`;
}

function fmtDate(value) {
  if (!value) return "tanpa batas";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

function fmtDaysLeft(expiresAt) {
  if (!expiresAt) return "tanpa batas";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "kadaluarsa";
  const days = Math.ceil(ms / 86_400_000);
  return `${days} hari lagi`;
}

function fmtAgo(value) {
  if (!value) return "belum dipakai";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "baru saja";
  if (mins < 60) return `${mins} menit lalu`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  return `${days} hari lalu`;
}

function keyState(k) {
  if (!k.isActive) return { variant: "error", label: "nonaktif" };
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()) {
    return { variant: "warning", label: "kadaluarsa" };
  }
  if (remaining(k) === 0) return { variant: "warning", label: "habis" };
  return { variant: "success", label: "aktif" };
}

// Berapa persen saldo sudah terpakai, buat bar + warna.
function levelOf(k) {
  const total = k.tokenBalance ?? 0;
  const spent = k.tokensSpent ?? 0;
  if (total <= 0) return { pct: 0, tone: "neutral", hint: "tanpa batas" };
  const pct = Math.min(100, Math.round((spent / total) * 100));
  if (remaining(k) === 0) return { pct: 100, tone: "red", hint: "habis" };
  if (pct >= 90) return { pct, tone: "red", hint: "hampir habis" };
  if (pct >= 60) return { pct, tone: "amber", hint: "menipis" };
  return { pct, tone: "green", hint: "aman" };
}

const TONE_BAR = {
  green: "bg-green-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  neutral: "bg-neutral-500",
};

function Stat({ label, value }) {
  return (
    <div className="flex flex-col gap-1 rounded-[14px] border border-border-subtle bg-surface p-3">
      <span className="text-xs uppercase tracking-wide text-text-muted">{label}</span>
      <span className="text-lg font-semibold text-text-main">{value}</span>
    </div>
  );
}

export default function PantauKeyPage() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const { copy, copied } = useCopyToClipboard();

  const load = useCallback(async () => {
    try {
      const data = await api("/api/keys");
      setKeys(data.keys || []);
      setUpdatedAt(new Date());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time bootstrap fetch on mount; nothing else feeds this list.
    load();
  }, [load]);

  const prepaid = useMemo(() => keys.filter(isResale), [keys]);

  const summary = useMemo(() => {
    let active = 0;
    let sisaAktif = 0;
    let terpakai = 0;
    let low = 0;
    let zero = 0;
    for (const k of prepaid) {
      const left = remaining(k) ?? 0;
      terpakai += k.tokensSpent ?? 0;
      if (k.isActive) {
        active += 1;
        sisaAktif += left;
      }
      if (remaining(k) === 0) zero += 1;
      else if (levelOf(k).tone === "red") low += 1;
    }
    return { total: prepaid.length, active, sisaAktif, terpakai, low, zero };
  }, [prepaid]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return prepaid
      .filter((k) => !q || String(k.name || "").toLowerCase().includes(q))
      .sort((a, b) => (remaining(a) ?? 0) - (remaining(b) ?? 0));
  }, [prepaid, query]);

  return (
    <div className="flex flex-col gap-4 pb-16">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-text-main">Pantau Key</h1>
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
            <span className="material-symbols-outlined text-[16px]">refresh</span>
            <span>Muat ulang</span>
          </Button>
        </div>
        <p className="text-sm text-text-muted">
          Sisa saldo tiap key resale — terpisah dari Endpoint &amp; Key, di sini cuma pantau.
          {updatedAt ? ` Diperbarui ${updatedAt.toLocaleTimeString("id-ID")}.` : ""}
        </p>
      </div>

      {error && (
        <div className="rounded-[10px] border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          Gagal memuat data: {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Key resale" value={String(summary.total)} />
        <Stat label="Aktif" value={String(summary.active)} />
        <Stat label="Sisa saldo aktif" value={fmtTokens(summary.sisaAktif)} />
        <Stat label="Total terpakai" value={fmtTokens(summary.terpakai)} />
      </div>

      {(summary.zero > 0 || summary.low > 0) && (
        <div className="rounded-[10px] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
          {summary.zero > 0 && `${summary.zero} key habis. `}
          {summary.low > 0 && `${summary.low} key hampir habis. `}
          Pertimbangkan top-up atau nonaktifkan key-nya.
        </div>
      )}

      <Card padding="sm" title={`Saldo per key (${visible.length} dari ${prepaid.length})`}>
        {loading ? (
          <CardSkeleton />
        ) : prepaid.length === 0 ? (
          <p className="text-sm text-text-muted">
            Belum ada key resale. Key yang kamu buat di Resale otomatis tampil di sini.
          </p>
        ) : (
          <>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari nama key"
              inputClassName="text-sm"
            />

            <div className="mt-2 flex flex-col divide-y divide-border-subtle">
              {visible.map((key) => {
                const state = keyState(key);
                const left = remaining(key);
                const level = levelOf(key);
                const source = key.source === "resell" ? "resale" : "manual";
                const copyId = `k-${key.id}`;

                return (
                  <details key={key.id} className="group py-3">
                    <summary className="flex cursor-pointer list-none flex-col gap-2 [&::-webkit-details-marker]:hidden">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-main">
                          {key.name}
                        </span>
                        <Badge variant={state.variant}>{state.label}</Badge>
                        <span className="shrink-0 text-text-muted transition-transform group-open:rotate-90">
                          ›
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                          <div
                            className={`h-full rounded-full ${TONE_BAR[level.tone]}`}
                            style={{ width: `${level.pct}%` }}
                          />
                        </div>
                        <span className="shrink-0 text-xs text-text-muted">
                          sisa {fmtTokens(left)} token · {level.hint}
                        </span>
                      </div>
                    </summary>

                    <div className="mt-2 flex flex-col gap-2">
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                        <span>Sumber: {source}</span>
                        <span>Terpakai: {fmtTokens(key.tokensSpent ?? 0)} token</span>
                        <span>
                          Masa aktif: {fmtDate(key.expiresAt)} ({fmtDaysLeft(key.expiresAt)})
                        </span>
                        <span>Terakhir: {fmtAgo(key.lastUsedAt)}</span>
                        <span>Dipakai {(key.usedCount ?? 0).toLocaleString("id-ID")}&#215;</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate rounded-[10px] border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-text-muted">
                          {key.keyDisplay}
                        </code>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => copy(key.keyDisplay, copyId)}
                        >
                          {copied === copyId ? "Tersalin" : "Salin"}
                        </Button>
                      </div>
                    </div>
                  </details>
                );
              })}

              {visible.length === 0 && (
                <p className="py-3 text-sm text-text-muted">Tidak ada key yang cocok.</p>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}