"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Button, Input, Modal, ConfirmModal, Badge, CardSkeleton, KeyQuotaFields } from "@/shared/components";
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
      const [k, c, settings] = await Promise.all([api("/api/keys"), api("/api/redeem-codes"), api("/api/settings")]);
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
      if (codeForm.quotaM !== "") body.tokenValue = Math.round(Number(codeForm.quotaM) * 1_000_000);
      if (codeForm.days !== "") body.extendsDays = Number(codeForm.days);
      // The whole policy, not just the token total: a seller selling "2jt token,
      // 60 request per menit" has to be able to say both.
      const { limits, set } = parseQuota(codeForm.quota);
      if (set > 0) body.limits = limits;
      if (body.tokenValue === undefined && body.extendsDays === undefined && set === 0) {
        throw new Error("Isi kuota token, masa aktif, atau salah satu batas di Kuota lengkap");
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
      const body = { name: manual.name.trim() };
      if (!body.name) throw new Error("Nama key wajib diisi");
      if (manual.quotaM !== "") body.tokenBalance = Math.round(Number(manual.quotaM) * 1_000_000);
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
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-text-muted">Halaman tukar</span>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-[10px] border border-border bg-surface-2 px-3 py-2 font-mono text-[13px] text-text-main">
                {redeemUrl}
              </code>
              <Button variant="secondary" size="sm" onClick={() => copy(redeemUrl, "redeem-url")}>
                {copied === "redeem-url" ? "Tersalin" : "Salin"}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-text-muted">Base URL</span>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-[10px] border border-border bg-surface-2 px-3 py-2 font-mono text-[13px] text-text-main">
                {apiBase}
              </code>
              <Button variant="secondary" size="sm" onClick={() => copy(apiBase, "api-base")}>
                {copied === "api-base" ? "Tersalin" : "Salin"}
              </Button>
            </div>
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
            type="number"
            min="0"
            step="0.5"
            value={codeForm.quotaM}
            onChange={(e) => setCodeForm({ ...codeForm, quotaM: e.target.value })}
            placeholder="5"
            hint="Kosong = tanpa batas token."
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

        {/* The rest of the quota surface. Collapsed because most batches sell on
            tokens alone; open it and the code carries every axis you fill in. */}
        <details className="mt-3 rounded-[10px] border border-border-subtle bg-surface-2 p-3">
          <summary className="cursor-pointer text-xs font-medium text-text-main">
            Kuota lengkap (opsional) — request, TPM, barengan, per hari/minggu/bulan
          </summary>
          <div className="mt-3">
            <KeyQuotaFields
              value={codeForm.quota}
              onChange={(quota) => setCodeForm({ ...codeForm, quota })}
              omit={["tokenBalance"]}
            />
            <p className="mt-2 text-xs text-text-muted">
              Kosongkan yang tidak dipakai. Batas ini nempel ke key yang buyer dapat.
            </p>
          </div>
        </details>
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
          <div className="flex flex-col">
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
        action={
          <Button variant="ghost" size="sm" onClick={() => { window.location.href = "/dashboard/endpoint"; }}>
            Atur di Keys
          </Button>
        }
      >
        {loading ? (
          <CardSkeleton />
        ) : keys.length === 0 ? (
          <p className="text-sm text-text-muted">Belum ada key. Buyer dapat key sendiri lewat kode.</p>
        ) : (
          <div className="flex flex-col">
            {keys.map((key) => {
              const state = keyState(key);
              const left = remaining(key);
              return (
                <Row key={key.id}>
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-text-main">{key.name}</span>
                      <Badge variant={state.variant}>{state.label}</Badge>
                    </div>
                    <span className="font-mono text-xs text-text-muted">{key.keyDisplay}</span>
                    <span className="text-xs text-text-muted">
                      sisa {fmtQuota(left)} · sampai {fmtDate(key.expiresAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
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
                </Row>
              );
            })}
          </div>
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
            type="number"
            min="0"
            step="0.5"
            value={manual.quotaM}
            onChange={(e) => setManual({ ...manual, quotaM: e.target.value })}
            placeholder="kosong = tanpa batas"
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
        <details className="mt-3 rounded-[10px] border border-border-subtle bg-surface-2 p-3">
          <summary className="cursor-pointer text-xs font-medium text-text-main">Kuota lengkap (opsional)</summary>
          <div className="mt-3">
            <KeyQuotaFields
              value={manual.quota}
              onChange={(quota) => setManual({ ...manual, quota })}
              omit={["tokenBalance"]}
            />
          </div>
        </details>
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
