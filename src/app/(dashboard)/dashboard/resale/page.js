"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Button, Input, Modal, ConfirmModal, Badge, CardSkeleton } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { emptyQuota, parseQuota, quotaSummary } from "@/shared/utils/keyQuota";

// Resale, one screen, phone first.
//
// The product is a code: a buyer buys a code, opens the redeem page, and walks
// away with a key. So this page is built around minting codes and watching
// them, and everything a buyer never touches (ACL lists, provider pins, rate
// limits) lives on the keys page where it belongs. Keys minted here are keys
// like any other — the list is an overview, not a control panel.

const emptyCode = () => ({
  batchName: "",
  quantity: "10",
  quotaM: "5",
  days: "30",
  maxUses: "1",
  quota: emptyQuota(),
});
const emptyManual = () => ({ name: "", quotaM: "", days: "", quota: emptyQuota() });

// A fetch wrapper that surfaces the router's own error text: an admin staring at
// "HTTP 400" learns nothing.
async function api(path, options) {
  const res = await fetch(path, options);
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

function fmtDate(value) {
  if (!value) return "tanpa batas";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

// The unit the seller thinks in. Tokens are stored raw; only the surface
// divides, and "1.5 juta" reads better than 1500000.
function fmtQuota(tokens) {
  if (tokens === null || tokens === undefined) return "tanpa batas";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)} juta token`;
  }
  return `${tokens.toLocaleString("id-ID")} token`;
}

// One shared brain for the "x juta" fields (code batch + manual mint). Reads raw
// text, previews the real number live, and screams when it can't be read. Callers
// use type="text" inputMode="decimal" so "20.000.000" stays visible and rejectable:
// type="number" sanitizes it to "" -> quotaM "" -> key minted as unlimited (silent).
function quotaFieldHint(raw, multiplierText = null) {
  if (raw === "") return { hint: "Kosong = tanpa batas. Contoh: 5 untuk 5 juta.", error: "" };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { hint: "", error: `Angka tidak terbaca: "${raw}". Contoh benar: 20 untuk 20 juta.` };
  }
  const per = n * 1_000_000;
  const mult = multiplierText !== null && multiplierText !== "" ? Math.max(1, Number(multiplierText) || 0) : null;
  const total = mult ? per * mult : null;
  const text = total ? `${fmtQuota(per)} × ${mult} kode = ${fmtQuota(total)} total` : fmtQuota(per);
  return { hint: `= ${text}`, error: "" };
}

function remaining(key) {
  if (key.tokenBalance == null) return null;
  return Math.max(0, key.tokenBalance - (key.tokensSpent ?? 0));
}

function keyState(key) {
  if (!key.isActive) return { variant: "error", label: "nonaktif" };
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return { variant: "warning", label: "kadaluarsa" };
  if (remaining(key) === 0) return { variant: "warning", label: "habis" };
  return { variant: "success", label: "aktif" };
}

function codeState(code) {
  if (!code.isActive) return { variant: "error", label: "dicabut" };
  if (code.expiresAt && new Date(code.expiresAt).getTime() <= Date.now()) return { variant: "warning", label: "kadaluarsa" };
  if (code.usedCount >= code.maxUses) return { variant: "default", label: "terpakai" };
  return { variant: "success", label: "siap" };
}

function Row({ children }) {
  return <div className="flex flex-col gap-2 border-b border-border-subtle py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">{children}</div>;
}

export default function ResalePage() {
  const [keys, setKeys] = useState([]);
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);

  const [codeForm, setCodeForm] = useState(emptyCode);
  const [manual, setManual] = useState(emptyManual);
  const [mintedCodes, setMintedCodes] = useState(null);
  const [mintedKey, setMintedKey] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  // Key-list controls. Every redemption mints a key, so the list only grows;
  // uncapped it buries the forms below it and the page becomes a scroll hunt.
  const [keyQuery, setKeyQuery] = useState("");
  const [showAllKeys, setShowAllKeys] = useState(false);
  const { copy, copied } = useCopyToClipboard();

  // The address handed to a buyer. The dashboard may be open on an address a
  // buyer cannot reach (127.0.0.1, a LAN IP, the box's IP:port), so a pinned
  // public address wins; this page's own origin is the floor.
  const base = useMemo(() => {
    const pinned = String(publicBaseUrl || "").trim().replace(/\/+$/, "");
    if (pinned) return pinned;
    if (typeof window === "undefined") return "";
    return window.location.origin;
  }, [publicBaseUrl]);
  const apiBase = base ? `${base}/v1` : "/v1";
  const redeemUrl = base ? `${base}/tukar` : "/tukar";

  const load = useCallback(async () => {
    try {
      const [k, c, settings] = await Promise.all([api("/api/keys?source=resell"), api("/api/redeem-codes"), api("/api/settings")]);
      setKeys(k.keys || []);
      setCodes(c.codes || []);
      setPublicBaseUrl(String(settings?.publicBaseUrl || ""));
      setBanner(null);
    } catch (error) {
      setBanner({ kind: "error", text: `Gagal memuat data: ${error.message}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time bootstrap fetch on mount; nothing else feeds these lists.
    load();
  }, [load]);

  const flash = (kind, text) => {
    setBanner({ kind, text });
    setTimeout(() => setBanner(null), 6000);
  };

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      flash("error", error.message);
    } finally {
      setBusy(false);
    }
  };

  const saveBase = () =>
    run(async () => {
      const pinned = String(publicBaseUrl || "").trim().replace(/\/+$/, "");
      await api("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicBaseUrl: pinned }),
      });
      setPublicBaseUrl(pinned);
      flash("ok", pinned ? `Alamat buyer jadi ${pinned}` : "Alamat buyer kembali ke alamat dashboard ini.");
    });

  // ---- codes -------------------------------------------------------------
  const handleMintCodes = () =>
    run(async () => {
      const body = { quantity: Number(codeForm.quantity) || 1, maxUses: Number(codeForm.maxUses) || 1 };
      if (codeForm.batchName.trim()) body.batchName = codeForm.batchName.trim();
      if (codeForm.quotaM !== "") {
        const quotaNum = Number(codeForm.quotaM);
        if (!Number.isFinite(quotaNum) || quotaNum <= 0) {
          throw new Error(`Kuota per kode harus angka. Diterima: "${codeForm.quotaM}"`);
        }
        body.tokenValue = Math.round(quotaNum * 1_000_000);
      }
      if (codeForm.days !== "") body.extendsDays = Number(codeForm.days);
      // The whole policy, not just the token total: a seller selling "2jt token,
      // 60 request per menit" has to be able to say both.
      const { limits, set } = parseQuota(codeForm.quota);
      if (set > 0) body.limits = limits;
      if (body.tokenValue === undefined && body.extendsDays === undefined && set === 0) {
        throw new Error("Isi kuota token, masa aktif, atau salah satu batas (RPM/TPM/request)");
      }
      const data = await api("/api/redeem-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setMintedCodes(data.codes || []);
      setCodeForm(emptyCode());
      await load();
      flash("ok", `${(data.codes || []).length} kode dibuat.`);
    });

  const revokeCode = (code) =>
    run(async () => {
      await api(`/api/redeem-codes/${code.id}`, { method: "DELETE" });
      await load();
      flash("ok", `Kode ${code.code} dicabut.`);
    });

  const purgeCode = (code) =>
    run(async () => {
      await api(`/api/redeem-codes/${code.id}?purge=1`, { method: "DELETE" });
      await load();
      flash("ok", `Kode ${code.code} dihapus.`);
    });

  // ---- keys --------------------------------------------------------------
  const handleMintManual = () =>
    run(async () => {
      // Resell-scoped by construction: a manual mint is seller inventory, so it
      // is tagged resell and never surfaces on the Endpoint page.
      const body = { name: manual.name.trim(), source: "resell" };
      if (!body.name) throw new Error("Nama key wajib diisi");
      if (manual.quotaM !== "") {
        const quotaNum = Number(manual.quotaM);
        if (!Number.isFinite(quotaNum) || quotaNum <= 0) {
          // "20 juta" / "20.000.000" → NaN → JSON null → key minted unwittingly
          // unlimited. Loud failure beats a silently wrong key.
          throw new Error(`Kuota harus angka (contoh: 20 untuk 20 juta). Diterima: "${manual.quotaM}"`);
        }
        body.tokenBalance = Math.round(quotaNum * 1_000_000);
      }
      if (manual.days !== "") body.expiresAt = new Date(Date.now() + Number(manual.days) * 86400000).toISOString();
      const { limits, set } = parseQuota(manual.quota);
      if (set > 0) body.limits = limits;
      const data = await api("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setMintedKey(data.keys ? data.keys[0] : data);
      setManual(emptyManual());
      await load();
    });

  const toggleKey = (key) =>
    run(async () => {
      await api(`/api/keys/${key.id}/toggle`, { method: "POST" });
      await load();
    });

  const rotateKey = (key) =>
    run(async () => {
      const data = await api(`/api/keys/${key.id}/rotate`, { method: "POST" });
      setMintedKey(data.key || data);
      await load();
      flash("ok", "Key dirotasi. Yang lama langsung mati.");
    });

  const deleteKey = (key) =>
    run(async () => {
      await api(`/api/keys/${key.id}`, { method: "DELETE" });
      await load();
      flash("ok", `Key ${key.name} dihapus.`);
    });

  const codeSummary = (code) => {
    const parts = [fmtQuota(code.tokenValue)];
    if (code.extendsDays !== null) parts.push(`${code.extendsDays} hari`);
    const extra = quotaSummary(code.limits);
    if (extra) parts.push(extra);
    parts.push(`${code.usedCount}/${code.maxUses} dipakai`);
    return parts.join(" · ");
  };

  const liveKeys = keys.filter((k) => k.isActive);
  const openCodes = codes.filter((c) => c.isActive && c.usedCount < c.maxUses);

  // Active first, newest first, searchable. Inactive keys are hidden by default
  // because they are history, not stock.
  const visibleKeys = useMemo(() => {
    const q = keyQuery.trim().toLowerCase();
    return keys
      .filter((k) => (showAllKeys || k.isActive) && (!q || String(k.name || "").toLowerCase().includes(q)))
      .sort(
        (a, b) =>
          Number(b.isActive) - Number(a.isActive) ||
          String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
      );
  }, [keys, keyQuery, showAllKeys]);

  return (
    <div className="flex flex-col gap-4 pb-16">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-text-main">Resale</h1>
        <p className="text-sm text-text-muted">Bikin kode, kirim ke buyer, buyer tukar sendiri.</p>
      </div>

      {banner && (
        <div
          className={`rounded-[10px] px-3 py-2 text-sm ${
            banner.kind === "ok"
              ? "border border-green-500/30 bg-green-500/10 text-green-600"
              : "border border-red-500/30 bg-red-500/10 text-red-500"
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* Alamat buyer */}
      <Card padding="sm" title="Alamat buat buyer">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[10px] border border-border bg-surface-2 px-3 py-2 font-mono text-[13px] text-text-main">
              {redeemUrl}
            </code>
            <Button variant="secondary" size="sm" onClick={() => copy(redeemUrl, "redeem-url")}>
              {copied === "redeem-url" ? "Tersalin" : "Salin"}
            </Button>
          </div>
          <details className="group">
            <summary className="cursor-pointer select-none text-xs uppercase tracking-wide text-text-muted">
              Alamat API &amp; domain publik
            </summary>
            <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-[10px] border border-border bg-surface-2 px-3 py-2 font-mono text-[13px] text-text-main">
                  {apiBase}
                </code>
                <Button variant="secondary" size="sm" onClick={() => copy(apiBase, "api-base")}>
                  {copied === "api-base" ? "Tersalin" : "Salin"}
                </Button>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <Input
                  label="Domain publik"
                  value={publicBaseUrl}
                  onChange={(e) => setPublicBaseUrl(e.target.value)}
                  placeholder="https://router.contoh.com"
                  hint="Kosongkan kalau buyer pakai alamat dashboard ini."
                  className="flex-1"
                />
                <Button variant="secondary" className="sm:mt-6" onClick={saveBase} disabled={busy}>
                  Simpan
                </Button>
              </div>
            </div>
          </details>
        </div>
      </Card>

      {/* Bikin kode */}
      <Card padding="sm" title="Bikin kode" subtitle="Kuota dan masa aktif berlaku untuk key yang buyer dapat.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Nama batch (opsional)"
            value={codeForm.batchName}
            onChange={(e) => setCodeForm({ ...codeForm, batchName: e.target.value })}
            placeholder="batch-agustus"
          />
          <Input
            label="Jumlah kode"
            type="number"
            min="1"
            value={codeForm.quantity}
            onChange={(e) => setCodeForm({ ...codeForm, quantity: e.target.value })}
          />
          <Input
            label="Kuota per kode (juta token)"
            type="text"
            inputMode="decimal"
            value={codeForm.quotaM}
            onChange={(e) => setCodeForm({ ...codeForm, quotaM: e.target.value })}
            placeholder="contoh: 5"
            hint={quotaFieldHint(codeForm.quotaM, codeForm.quantity).hint}
            error={quotaFieldHint(codeForm.quotaM, codeForm.quantity).error}
          />
          <Input
            label="Masa aktif (hari)"
            type="number"
            min="0"
            value={codeForm.days}
            onChange={(e) => setCodeForm({ ...codeForm, days: e.target.value })}
            placeholder="30"
            hint="Kosong = tanpa batas waktu."
          />
          <Input
            label="Maks pakai per kode"
            type="number"
            min="1"
            value={codeForm.maxUses}
            onChange={(e) => setCodeForm({ ...codeForm, maxUses: e.target.value })}
            hint="1 = sekali pakai."
          />
        </div>

        {/* The buyer-facing panel stops at the request-level axes: rpm (how
            often), tpm (how much per minute), and a per-request cap. The rest
            of the matrix (harian/mingguan/bulanan/barengan) is engine-admin
            territory, not a reseller selling "5 juta token, 30 hari". The
            keys page still exposes the full surface. */}
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input
            label="Request per menit (opsional)"
            type="number"
            min="0"
            value={codeForm.quota.rpm}
            onChange={(e) => setCodeForm({ ...codeForm, quota: { ...codeForm.quota, rpm: e.target.value } })}
            placeholder="kosong = tanpa batas"
          />
          <Input
            label="Token per menit (opsional)"
            type="number"
            min="0"
            value={codeForm.quota.rateLimitTpm}
            onChange={(e) => setCodeForm({ ...codeForm, quota: { ...codeForm.quota, rateLimitTpm: e.target.value } })}
            placeholder="kosong = tanpa batas"
          />
          <Input
            label="Token per request (opsional)"
            type="number"
            min="0"
            value={codeForm.quota.maxTokens}
            onChange={(e) => setCodeForm({ ...codeForm, quota: { ...codeForm.quota, maxTokens: e.target.value } })}
            placeholder="kosong = tanpa batas"
          />
        </div>
        <Button className="mt-4 w-full sm:w-auto" onClick={handleMintCodes} disabled={busy} loading={busy}>
          Bikin kode
        </Button>
      </Card>

      {/* Kode */}
      <Card padding="sm" title={`Kode (${openCodes.length} siap / ${codes.length} total)`}>
        {loading ? (
          <CardSkeleton />
        ) : codes.length === 0 ? (
          <p className="text-sm text-text-muted">Belum ada kode. Bikin batch pertama di atas.</p>
        ) : (
          <div className="flex max-h-[22rem] flex-col overflow-y-auto pr-1">
            {codes.map((code) => {
              const state = codeState(code);
              return (
                <Row key={code.id}>
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-sm text-text-main">{code.code}</code>
                      <Badge variant={state.variant}>{state.label}</Badge>
                    </div>
                    <span className="text-xs text-text-muted">{codeSummary(code)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => copy(code.code, code.id)}>
                      {copied === code.id ? "Tersalin" : "Salin"}
                    </Button>
                    {code.isActive ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setConfirmState({
                            title: "Cabut kode",
                            message: `Kode ${code.code} tidak bisa ditukar lagi. Lanjut?`,
                            onConfirm: () => revokeCode(code),
                          })
                        }
                      >
                        Cabut
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setConfirmState({
                            title: "Hapus kode",
                            message: `Hapus permanen ${code.code}?`,
                            onConfirm: () => purgeCode(code),
                          })
                        }
                      >
                        Hapus
                      </Button>
                    )}
                  </div>
                </Row>
              );
            })}
          </div>
        )}
      </Card>

      {/* Keys */}
      <Card
        padding="sm"
        title={`Key (${liveKeys.length} aktif / ${keys.length} total)`}
        subtitle="Cuma key dari kode atau bikin manual di halaman ini — key Endpoint gak masuk daftar ini."
      >
        {loading ? (
          <CardSkeleton />
        ) : keys.length === 0 ? (
          <p className="text-sm text-text-muted">Belum ada key. Buyer dapat key sendiri lewat kode.</p>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2">
              <Input
                value={keyQuery}
                onChange={(e) => setKeyQuery(e.target.value)}
                placeholder="Cari nama key"
                inputClassName="text-sm"
              />
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => setShowAllKeys((v) => !v)}
              >
                {showAllKeys ? "Aktif saja" : `Semua (${keys.length})`}
              </Button>
            </div>
            {visibleKeys.length === 0 ? (
              <p className="text-sm text-text-muted">Tidak ada key yang cocok.</p>
            ) : (
          <div className="flex max-h-[22rem] flex-col divide-y divide-border-subtle overflow-y-auto pr-1">
            {visibleKeys.map((key) => {
              const state = keyState(key);
              const left = remaining(key);
              const copiedId = `key-${key.id}`;
              return (
                // Collapsed row is ONE line per key (nama, badge, sisa, masa aktif):
                // with 50 keys the list is a scan, not a scroll hunt. The key string
                // and the three actions sit one tap away inside the same row, so the
                // buttons stop competing with the names for width on mobile.
                <details key={key.id} className="group py-2.5">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-main">{key.name}</span>
                    <Badge variant={state.variant}>{state.label}</Badge>
                    <span className="basis-full truncate text-xs text-text-muted sm:basis-auto sm:shrink-0">
                      {fmtQuota(left)} · {fmtDate(key.expiresAt)}
                    </span>
                    <span className="shrink-0 text-text-muted transition-transform group-open:rotate-90">›</span>
                  </summary>
                  <div className="mt-2 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded-[10px] border border-border bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-text-muted">
                        {key.keyDisplay}
                      </code>
                      <Button variant="secondary" size="sm" onClick={() => copy(key.keyDisplay, copiedId)}>
                        {copied === copiedId ? "Tersalin" : "Salin"}
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => toggleKey(key)}>
                        {key.isActive ? "Nonaktifkan" : "Aktifkan"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setConfirmState({
                            title: "Rotasi key",
                            message: `Key lama ${key.name} langsung mati. Lanjut?`,
                            onConfirm: () => rotateKey(key),
                          })
                        }
                      >
                        Rotasi
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setConfirmState({
                            title: "Hapus key",
                            message: `Hapus permanen ${key.name}?`,
                            onConfirm: () => deleteKey(key),
                          })
                        }
                      >
                        Hapus
                      </Button>
                    </div>
                  </div>
                </details>
              );
            })}
          </div>
            )}
          </>
        )}
      </Card>

      {/* Manual mint, out of the way */}
      <details className="rounded-[14px] border border-border-subtle bg-surface p-4">
        <summary className="cursor-pointer text-sm font-medium text-text-main">Bikin key manual (tanpa kode)</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input
            label="Nama"
            value={manual.name}
            onChange={(e) => setManual({ ...manual, name: e.target.value })}
            placeholder="teman-budi"
          />
          <Input
            label="Kuota (juta token)"
            type="text"
            inputMode="decimal"
            value={manual.quotaM}
            onChange={(e) => setManual({ ...manual, quotaM: e.target.value })}
            placeholder="contoh: 20"
            hint={quotaFieldHint(manual.quotaM).hint}
            error={quotaFieldHint(manual.quotaM).error}
          />
          <Input
            label="Masa aktif (hari)"
            type="number"
            min="0"
            value={manual.days}
            onChange={(e) => setManual({ ...manual, days: e.target.value })}
            placeholder="kosong = tanpa batas"
          />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input
            label="Request per menit (opsional)"
            type="number"
            min="0"
            value={manual.quota.rpm}
            onChange={(e) => setManual({ ...manual, quota: { ...manual.quota, rpm: e.target.value } })}
            placeholder="kosong = tanpa batas"
          />
          <Input
            label="Token per menit (opsional)"
            type="number"
            min="0"
            value={manual.quota.rateLimitTpm}
            onChange={(e) => setManual({ ...manual, quota: { ...manual.quota, rateLimitTpm: e.target.value } })}
            placeholder="kosong = tanpa batas"
          />
          <Input
            label="Token per request (opsional)"
            type="number"
            min="0"
            value={manual.quota.maxTokens}
            onChange={(e) => setManual({ ...manual, quota: { ...manual.quota, maxTokens: e.target.value } })}
            placeholder="kosong = tanpa batas"
          />
        </div>
        <Button className="mt-3 w-full sm:w-auto" variant="secondary" onClick={handleMintManual} disabled={busy}>
          Bikin key
        </Button>
      </details>

      {/* Hasil */}
      {mintedCodes && (
        <Modal
          isOpen
          onClose={() => setMintedCodes(null)}
          title={`${mintedCodes.length} kode baru`}
          footer={
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="secondary" onClick={() => copy(mintedCodes.map((c) => c.code).join("\n"), "all-codes")}>
                {copied === "all-codes" ? "Tersalin" : "Salin semua"}
              </Button>
              <Button onClick={() => copy(redeemUrl, "redeem-url-2")}>
                {copied === "redeem-url-2" ? "Tersalin" : "Salin link tukar"}
              </Button>
            </div>
          }
        >
          <p className="mb-3 text-sm text-text-muted">
            Kirim salah satu kode ke buyer. Buyer buka <span className="font-mono">{redeemUrl}</span>.
          </p>
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-[10px] border border-border bg-surface-2 p-3">
            {mintedCodes.map((code) => (
              <code key={code.id} className="font-mono text-sm text-text-main">
                {code.code}
              </code>
            ))}
          </div>
        </Modal>
      )}

      {mintedKey && (
        <Modal
          isOpen
          onClose={() => setMintedKey(null)}
          title="Key baru"
          footer={
            <Button onClick={() => copy(mintedKey.key, "minted-key")}>
              {copied === "minted-key" ? "Tersalin" : "Salin key"}
            </Button>
          }
        >
          <p className="mb-3 text-sm text-text-muted">Simpan sekarang. Halaman ini tidak menyimpan key mentah.</p>
          <code className="block break-all rounded-[10px] border border-border bg-surface-2 p-3 font-mono text-sm text-text-main">
            {mintedKey.key}
          </code>
        </Modal>
      )}

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={() => {
          const action = confirmState?.onConfirm;
          setConfirmState(null);
          action?.();
        }}
        title={confirmState?.title || ""}
        message={confirmState?.message || ""}
      />
    </div>
  );
}
