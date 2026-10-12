"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Button, Input, Modal, ConfirmModal, Toggle, Badge, CardSkeleton } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// Kinds the router can gate a sold key on. "llm" is the chat surface; the rest
// are the media/search lanes.
const KINDS = [
  { id: "llm", label: "LLM / chat" },
  { id: "embedding", label: "Embedding" },
  { id: "image", label: "Image" },
  { id: "tts", label: "Text to speech" },
  { id: "stt", label: "Speech to text" },
  { id: "web", label: "Web fetch / search" },
];

const emptyMint = () => ({
  name: "",
  quantity: "1",
  allKinds: true,
  kinds: [],
  providers: "",
  combos: "",
  ips: "",
  balance: "",
  days: "",
  rpm: "",
  persona: true,
});

const emptyCode = () => ({
  batchName: "",
  quantity: "10",
  tokenValue: "",
  extendsDays: "",
  maxUses: "1",
});

function splitList(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A fetch wrapper that surfaces the router's own error text: an admin staring at
// "HTTP 400" learns nothing, the message "allowedIps must be an array of
// non-empty strings" tells them what to fix.
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
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

function remaining(key) {
  if (key.tokenBalance == null) return null;
  return Math.max(0, key.tokenBalance - (key.tokensSpent ?? 0));
}

function keyState(key) {
  if (!key.isActive) return { variant: "error", label: "nonaktif" };
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) {
    return { variant: "warning", label: "kadaluarsa" };
  }
  const left = remaining(key);
  if (left === 0) return { variant: "warning", label: "saldo habis" };
  return { variant: "success", label: "aktif" };
}

export default function ResalePage() {
  const [keys, setKeys] = useState([]);
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);

  const [mint, setMint] = useState(emptyMint);
  const [minted, setMinted] = useState(null);
  const [codeForm, setCodeForm] = useState(emptyCode);
  const [mintedCodes, setMintedCodes] = useState(null);
  const [edit, setEdit] = useState(null);
  const [logs, setLogs] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [revealed, setRevealed] = useState({});
  const [confirmState, setConfirmState] = useState(null);
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const { copy, copied } = useCopyToClipboard();

  // The address to hand a buyer. The dashboard may be opened on an address the
  // buyer cannot reach (127.0.0.1, a LAN IP, or the box's IP:port), so a pinned
  // public address wins; the page's own origin is the floor.
  const baseUrl = useMemo(() => {
    const pinned = String(publicBaseUrl || "").trim().replace(/\/+$/, "");
    if (pinned) return `${pinned}/v1`;
    if (typeof window === "undefined") return "/v1";
    return `${window.location.origin}/v1`;
  }, [publicBaseUrl]);

  const load = useCallback(async () => {
    try {
      const [k, c, settings] = await Promise.all([
        api("/api/keys"),
        api("/api/redeem-codes"),
        api("/api/settings"),
      ]);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time bootstrap fetch on mount; the key list has no other source.
    load();
  }, [load]);

  const savePublicBase = async () => {
    const pinned = String(publicBaseUrl || "").trim().replace(/\/+$/, "");
    await api("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicBaseUrl: pinned }),
    });
    setPublicBaseUrl(pinned);
    flash("ok", pinned ? `Base URL buyer jadi ${pinned}/v1` : "Base URL buyer kembali ke alamat dashboard ini.");
  };

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

  // ---- mint keys ---------------------------------------------------------
  const handleMint = () =>
    run(async () => {
      const body = {
        name: mint.name.trim(),
        quantity: Number(mint.quantity) || 1,
        personaInject: mint.persona,
      };
      if (!body.name) throw new Error("Nama key wajib diisi");
      // An empty list is NOT "no restriction": the repo reads [] as "deny every
      // address". Only send the field when the seller actually typed one.
      const ips = splitList(mint.ips);
      if (ips.length) body.allowedIps = ips;
      if (mint.balance !== "") body.tokenBalance = Number(mint.balance);
      if (mint.days !== "") {
        body.expiresAt = new Date(Date.now() + Number(mint.days) * 86400000).toISOString();
      }
      if (mint.rpm !== "") body.limits = { rpm: Number(mint.rpm) };
      if (!mint.allKinds) {
        if (!mint.kinds.length) throw new Error("Pilih minimal satu jenis akses, atau centang 'semua'");
        body.allowedKinds = mint.kinds;
      }
      if (mint.providers.trim()) body.allowedProviders = splitList(mint.providers);
      if (mint.combos.trim()) body.allowedCombos = splitList(mint.combos);

      const data = await api("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const created = data.keys ? data.keys : [data];
      setMinted({ keys: created });
      setMint(emptyMint());
      await load();
      flash("ok", `${created.length} key dibuat. Salin sekarang — halaman ini tidak menyimpan riwayat.`);
    });

  // ---- per-key actions ---------------------------------------------------
  const handleRotate = (key) =>
    setConfirmState({
      title: "Rotate key?",
      message: `${key.name}: secret lama langsung mati. Buyer harus diganti key-nya.`,
      confirmText: "Rotate",
      onConfirm: async () => {
        setConfirmState(null);
        await run(async () => {
          const data = await api(`/api/keys/${key.id}/rotate`, { method: "POST" });
          setMinted({ keys: [data], title: "Secret baru" });
          await load();
          flash("ok", `${key.name} dirotasi. Salin secret baru sekarang.`);
        });
      },
    });

  const handleToggle = (key) =>
    run(async () => {
      await api(`/api/keys/${key.id}/toggle`, { method: "POST" });
      await load();
    });

  const handleDelete = (key) =>
    setConfirmState({
      title: "Hapus key?",
      message: `${key.name} hilang permanen dan langsung berhenti jalan untuk buyer.`,
      confirmText: "Hapus",
      onConfirm: async () => {
        setConfirmState(null);
        await run(async () => {
          await api(`/api/keys/${key.id}`, { method: "DELETE" });
          await load();
          flash("ok", `${key.name} dihapus.`);
        });
      },
    });

  const handleEditSave = () =>
    run(async () => {
      const { key, balance, ips, days, rpm } = edit;
      const body = {};
      body.tokenBalance = balance === "" ? null : Number(balance);
      const list = splitList(ips);
      body.allowedIps = list.length ? list : null;
      if (days !== "") {
        body.expiresAt = new Date(Date.now() + Number(days) * 86400000).toISOString();
      }
      if (rpm !== "") body.limits = { rpm: Number(rpm) };
      await api(`/api/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setEdit(null);
      await load();
      flash("ok", `${key.name} diperbarui.`);
    });

  const handleLogs = (key) =>
    run(async () => {
      setLogs({ loading: true, name: key.name });
      const data = await api(`/api/keys/${key.id}/logs?pageSize=50`);
      setLogs({ ...data, loading: false });
    });

  // The two calls a buyer makes first. Read-only, so a seller can check a key
  // before shipping it without spending the buyer's balance.
  const handleTest = (key) =>
    run(async () => {
      const headers = { Authorization: `Bearer ${key.key}` };
      const out = [];
      try {
        const me = await api("/v1/key", { headers });
        out.push({
          label: "GET /v1/key",
          ok: true,
          detail: `sisa ${me.remainingTokens == null ? "tanpa batas" : me.remainingTokens} token · gate ${
            me.gate?.allowed ? "boleh jalan" : `ditolak (${me.gate?.code || me.gate?.reason || "?"})`
          }`,
        });
      } catch (error) {
        out.push({ label: "GET /v1/key", ok: false, detail: error.message });
      }
      try {
        const models = await api("/v1/models", { headers });
        const list = models.data || [];
        out.push({
          label: "GET /v1/models",
          ok: true,
          detail: `${list.length} model terlihat · contoh: ${list.slice(0, 5).map((m) => m.id).join(", ") || "kosong"}`,
        });
      } catch (error) {
        out.push({ label: "GET /v1/models", ok: false, detail: error.message });
      }
      setTestResult({ name: key.name, keyDisplay: key.keyDisplay, out });
    });

  // ---- redeem codes ------------------------------------------------------
  const handleMintCodes = () =>
    run(async () => {
      const body = {
        quantity: Number(codeForm.quantity) || 1,
        maxUses: Number(codeForm.maxUses) || 1,
      };
      if (codeForm.batchName.trim()) body.batchName = codeForm.batchName.trim();
      if (codeForm.tokenValue !== "") body.tokenValue = Number(codeForm.tokenValue);
      if (codeForm.extendsDays !== "") body.extendsDays = Number(codeForm.extendsDays);
      if (body.tokenValue === undefined && body.extendsDays === undefined) {
        throw new Error("Isi nilai token dan/atau tambahan hari");
      }
      const data = await api("/api/redeem-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setMintedCodes(data.codes || []);
      await load();
      flash("ok", `${data.count} kode dibuat.`);
    });

  const handleRevoke = (code) =>
    setConfirmState({
      title: "Revoke kode?",
      message: `${code.code} tidak bisa dipakai lagi. Riwayat pemakaiannya tetap tersimpan.`,
      confirmText: "Revoke",
      onConfirm: async () => {
        setConfirmState(null);
        await run(async () => {
          await api(`/api/redeem-codes/${code.id}`, { method: "DELETE" });
          await load();
        });
      },
    });

  const copyText = (text, id) => copy(text, id);
  const copyAll = (list, id) => copy(list.map((k) => k.key).join("\n"), id);

  if (loading) {
    return (
      <div className="flex flex-col gap-5 p-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Resale</h1>
          <p className="text-sm text-text-muted">
            Jual akses router sebagai API key: bikin key, atur batas, kirim kode top-up, pantau pemakaian.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => run(load)} loading={busy}>
          Muat ulang
        </Button>
      </div>

      {banner && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            banner.kind === "ok"
              ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300"
              : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
          }`}
        >
          {banner.text}
        </div>
      )}

      <Card title="Yang dikirim ke buyer">
        <div className="flex flex-col gap-3 text-sm">
          <div>
            <div className="text-text-muted mb-1">Base URL</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-black/5 dark:bg-white/5 p-2 font-mono text-xs overflow-x-auto">
                {baseUrl}
              </code>
              <Button size="sm" variant="outline" onClick={() => copyText(baseUrl, "base")}>
                {copied === "base" ? "Tersalin" : "Copy"}
              </Button>
            </div>
          </div>
          <div>
            <div className="text-text-muted mb-1">Alamat publik (domain yang lu kasih ke buyer)</div>
            <div className="flex items-center gap-2">
              <Input
                value={publicBaseUrl}
                onChange={(e) => setPublicBaseUrl(e.target.value)}
                placeholder="https://router.contoh.com"
                className="flex-1 font-mono text-xs"
              />
              <Button size="sm" variant="secondary" onClick={() => run(savePublicBase)}>
                Simpan
              </Button>
            </div>
            <div className="text-text-muted text-xs mt-1">
              Kosong = pakai alamat dashboard ini. Isi domain reverse-proxy (mis. https://router.sintec.my.id) supaya buyer tidak pernah lihat IP:port.
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
              <div className="font-mono text-xs">POST {baseUrl}/chat/completions</div>
              <div className="text-text-muted text-xs mt-1">Endpoint yang dipakai buyer (format [OI]).</div>
            </div>
            <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
              <div className="font-mono text-xs">GET {baseUrl}/models</div>
              <div className="text-text-muted text-xs mt-1">Daftar model yang buyer lihat — sudah dipotong ACL key.</div>
            </div>
            <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
              <div className="font-mono text-xs">GET {baseUrl}/key</div>
              <div className="text-text-muted text-xs mt-1">Buyer cek diri sendiri: sisa saldo, ACL, IP asal, status gate.</div>
            </div>
            <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
              <div className="font-mono text-xs">POST {baseUrl}/redeem</div>
              <div className="text-text-muted text-xs mt-1">Buyer tukar kode top-up jadi saldo / tambahan masa aktif.</div>
            </div>
          </div>
          <div>
            <div className="text-text-muted mb-1">Header</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-black/5 dark:bg-white/5 p-2 font-mono text-xs">
                Authorization: Bearer &lt;key&gt;
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyText(`Authorization: Bearer <key>`, "hdr")}
              >
                {copied === "hdr" ? "Tersalin" : "Copy"}
              </Button>
            </div>
          </div>
          <div className="text-text-muted text-xs">
            Kalau buyer dapat <strong>401</strong> artinya key salah/nonaktif/kadaluarsa, <strong>403</strong> artinya key
            tidak boleh dari IP itu, <strong>402</strong> artinya saldo habis (suruh top-up, bukan retry),{" "}
            <strong>429</strong> artinya kena limit rate (tunggu lalu ulang). Pesan error-nya menyebut sebabnya.
          </div>
        </div>
      </Card>

      <Card title="Bikin key">
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Input label="Nama buyer" value={mint.name} onChange={(e) => setMint({ ...mint, name: e.target.value })} placeholder="buyer-budi" />
            <Input label="Jumlah (maks 100)" type="number" value={mint.quantity} onChange={(e) => setMint({ ...mint, quantity: e.target.value })} />
            <Input label="Saldo token (kosong = tanpa batas)" type="number" value={mint.balance} onChange={(e) => setMint({ ...mint, balance: e.target.value })} placeholder="200000" />
            <Input label="Masa aktif (hari, kosong = selamanya)" type="number" value={mint.days} onChange={(e) => setMint({ ...mint, days: e.target.value })} placeholder="30" />
            <Input label="Limit RPM (opsional)" type="number" value={mint.rpm} onChange={(e) => setMint({ ...mint, rpm: e.target.value })} />
            <Input label="Provider (pisah koma, kosong = semua)" value={mint.providers} onChange={(e) => setMint({ ...mint, providers: e.target.value })} placeholder="openai, anthropic" />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">IP buyer (satu per baris, kosong = dari mana saja)</label>
            <textarea
              className="rounded-lg border border-border bg-surface-2 p-2 font-mono text-xs min-h-[70px]"
              value={mint.ips}
              onChange={(e) => setMint({ ...mint, ips: e.target.value })}
              placeholder={"103.20.1.5\n45.12.77.9"}
            />
            <span className="text-xs text-text-muted">
              Isi hanya kalau buyer punya IP tetap. Salah isi = buyer kena 403 walau key benar.
            </span>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Jenis akses</label>
              <Toggle
                checked={mint.allKinds}
                onChange={(v) => setMint({ ...mint, allKinds: v })}
                label="Semua jenis"
                size="sm"
              />
            </div>
            {!mint.allKinds && (
              <div className="flex flex-wrap gap-3">
                {KINDS.map((k) => (
                  <label key={k.id} className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mint.kinds.includes(k.id)}
                      onChange={(e) =>
                        setMint({
                          ...mint,
                          kinds: e.target.checked
                            ? [...mint.kinds, k.id]
                            : mint.kinds.filter((x) => x !== k.id),
                        })
                      }
                    />
                    {k.label}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Combo (pisah koma, opsional)" value={mint.combos} onChange={(e) => setMint({ ...mint, combos: e.target.value })} placeholder="smart-fallback" />
            <div className="flex items-end">
              <Toggle
                checked={mint.persona}
                onChange={(v) => setMint({ ...mint, persona: v })}
                label="Pakai persona router"
                description="Matikan kalau buyer mau output polos"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleMint} loading={busy}>
              Bikin key
            </Button>
            <Button variant="ghost" onClick={() => setMint(emptyMint())}>
              Reset
            </Button>
          </div>
        </div>
      </Card>

      <Card title={`Key terjual (${keys.length})`}>
        {keys.length === 0 ? (
          <div className="text-sm text-text-muted">Belum ada key.</div>
        ) : (
          <div className="flex flex-col">
            {keys.map((key) => {
              const state = keyState(key);
              const left = remaining(key);
              return (
                <div key={key.id} className="flex flex-col gap-2 border-b border-border-subtle py-3 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{key.name}</span>
                    <Badge variant={state.variant} size="sm">
                      {state.label}
                    </Badge>
                    <span className="font-mono text-xs text-text-muted">
                      {revealed[key.id] ? key.key : key.keyDisplay}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setRevealed({ ...revealed, [key.id]: !revealed[key.id] })}>
                      {revealed[key.id] ? "Sembunyikan" : "Lihat"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => copyText(key.key, key.id)}>
                      {copied === key.id ? "Tersalin" : "Copy"}
                    </Button>
                  </div>

                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-muted">
                    <span>
                      saldo: {left == null ? "tanpa batas" : `${left} dari ${key.tokenBalance}`} · terpakai {key.tokensSpent ?? 0}
                    </span>
                    <span>request: {key.usedCount ?? 0}</span>
                    <span>kadaluarsa: {fmtDate(key.expiresAt)}</span>
                    <span>IP: {key.allowedIps?.length ? key.allowedIps.join(", ") : "bebas"}</span>
                    <span>
                      akses:{" "}
                      {key.allowedKinds?.length ? key.allowedKinds.join("/") : "semua jenis"}
                      {key.allowedProviders?.length ? ` · ${key.allowedProviders.join("/")}` : ""}
                      {key.allowedCombos?.length ? ` · combo ${key.allowedCombos.join("/")}` : ""}
                    </span>
                    <span>terakhir dipakai: {fmtDate(key.lastUsedAt)}</span>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => handleTest(key)} disabled={busy}>
                      Tes
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => handleLogs(key)} disabled={busy}>
                      Log
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setEdit({
                          key,
                          balance: key.tokenBalance == null ? "" : String(key.tokenBalance),
                          ips: (key.allowedIps || []).join("\n"),
                          days: "",
                          rpm: key.rpm == null ? "" : String(key.rpm),
                        })
                      }
                    >
                      Saldo &amp; IP
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => handleRotate(key)} disabled={busy}>
                      Rotate
                    </Button>
                    <Button size="sm" variant={key.isActive ? "ghost" : "secondary"} onClick={() => handleToggle(key)} disabled={busy}>
                      {key.isActive ? "Nonaktifkan" : "Aktifkan"}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => handleDelete(key)} disabled={busy}>
                      Hapus
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Kode top-up (redeem)">
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input label="Nama batch" value={codeForm.batchName} onChange={(e) => setCodeForm({ ...codeForm, batchName: e.target.value })} placeholder="topup-oktober" />
            <Input label="Jumlah kode" type="number" value={codeForm.quantity} onChange={(e) => setCodeForm({ ...codeForm, quantity: e.target.value })} />
            <Input label="Nilai token" type="number" value={codeForm.tokenValue} onChange={(e) => setCodeForm({ ...codeForm, tokenValue: e.target.value })} placeholder="100000" />
            <Input label="Tambah hari" type="number" value={codeForm.extendsDays} onChange={(e) => setCodeForm({ ...codeForm, extendsDays: e.target.value })} placeholder="30" />
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Input label="Maks pakai per kode" type="number" value={codeForm.maxUses} onChange={(e) => setCodeForm({ ...codeForm, maxUses: e.target.value })} />
            <div className="flex items-end">
              <Button onClick={handleMintCodes} loading={busy}>
                Bikin kode
              </Button>
            </div>
          </div>

          {codes.length === 0 ? (
            <div className="text-sm text-text-muted">Belum ada kode.</div>
          ) : (
            <div className="flex flex-col">
              <div className="text-xs text-text-muted mb-1">
                {codes.length} kode · belum dipakai {codes.filter((c) => c.usedCount === 0 && c.isActive).length} · habis{" "}
                {codes.filter((c) => c.usedCount >= c.maxUses).length} · di-revoke{" "}
                {codes.filter((c) => !c.isActive).length}
              </div>
              {codes.slice(0, 100).map((c) => (
                <div key={c.id} className="flex flex-wrap items-center gap-2 border-b border-border-subtle py-2 last:border-b-0 text-sm">
                  <span className="font-mono text-xs">{c.code}</span>
                  <Badge variant={!c.isActive ? "error" : c.usedCount >= c.maxUses ? "default" : "success"} size="sm">
                    {!c.isActive ? "revoked" : c.usedCount >= c.maxUses ? "habis" : "siap"}
                  </Badge>
                  <span className="text-xs text-text-muted">
                    {c.tokenValue ? `${c.tokenValue} token` : ""}
                    {c.tokenValue && c.extendsDays ? " + " : ""}
                    {c.extendsDays ? `${c.extendsDays} hari` : ""} · dipakai {c.usedCount}/{c.maxUses}
                    {c.batchName ? ` · ${c.batchName}` : ""}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => copyText(c.code, c.id)}>
                    {copied === c.id ? "Tersalin" : "Copy"}
                  </Button>
                  {c.isActive && (
                    <Button size="sm" variant="ghost" onClick={() => handleRevoke(c)} disabled={busy}>
                      Revoke
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Modal isOpen={!!minted} onClose={() => setMinted(null)} title={minted?.title || "Key baru — salin sekarang"} size="md">
        <div className="flex flex-col gap-3">
          <div className="text-sm text-text-muted">
            Secret hanya ditampilkan di sini. Kirim ke buyer lewat kanal pribadi; kalau hilang, pakai Rotate.
          </div>
          <div className="flex flex-col gap-2 max-h-[40vh] overflow-y-auto">
            {(minted?.keys || []).map((k) => (
              <div key={k.id || k.key} className="flex items-center gap-2 rounded border border-border-subtle bg-surface-2 p-2">
                <span className="flex-1 min-w-0 font-mono text-xs break-all">{k.key}</span>
                <Button size="sm" variant="ghost" onClick={() => copyText(k.key, k.key)}>
                  {copied === k.key ? "Tersalin" : "Copy"}
                </Button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button onClick={() => copyAll(minted?.keys || [], "all")}>
              {copied === "all" ? "Tersalin" : "Copy semua"}
            </Button>
            <Button variant="ghost" onClick={() => setMinted(null)}>
              Tutup
            </Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!mintedCodes} onClose={() => setMintedCodes(null)} title="Kode top-up baru" size="md">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 max-h-[40vh] overflow-y-auto">
            {(mintedCodes || []).map((c) => (
              <div key={c.id || c.code} className="flex items-center gap-2 rounded border border-border-subtle bg-surface-2 p-2">
                <span className="flex-1 font-mono text-xs">{c.code}</span>
                <Button size="sm" variant="ghost" onClick={() => copyText(c.code, c.code)}>
                  {copied === c.code ? "Tersalin" : "Copy"}
                </Button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => copy((mintedCodes || []).map((c) => c.code).join("\n"), "codes")}
            >
              {copied === "codes" ? "Tersalin" : "Copy semua"}
            </Button>
            <Button variant="ghost" onClick={() => setMintedCodes(null)}>
              Tutup
            </Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!edit} onClose={() => setEdit(null)} title={`Saldo & IP — ${edit?.key?.name || ""}`} size="sm">
        <div className="flex flex-col gap-3">
          <Input
            label="Saldo token (kosong = tanpa batas)"
            type="number"
            value={edit?.balance ?? ""}
            onChange={(e) => setEdit({ ...edit, balance: e.target.value })}
          />
          <Input
            label="Limit RPM (kosong = tak diubah)"
            type="number"
            value={edit?.rpm ?? ""}
            onChange={(e) => setEdit({ ...edit, rpm: e.target.value })}
          />
          <Input
            label="Perpanjang dari sekarang (hari)"
            type="number"
            value={edit?.days ?? ""}
            onChange={(e) => setEdit({ ...edit, days: e.target.value })}
            placeholder="kosong = biarkan"
          />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">IP allow-list (kosong = bebas)</label>
            <textarea
              className="rounded-lg border border-border bg-surface-2 p-2 font-mono text-xs min-h-[70px]"
              value={edit?.ips ?? ""}
              onChange={(e) => setEdit({ ...edit, ips: e.target.value })}
            />
          </div>
          <div className="text-xs text-text-muted">
            Saldo dihitung dari nol lagi saat diubah: isi total saldo yang baru, bukan tambahannya.
          </div>
          <div className="flex gap-2">
            <Button onClick={handleEditSave} loading={busy}>
              Simpan
            </Button>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              Batal
            </Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!logs} onClose={() => setLogs(null)} title={`Log — ${logs?.name || ""}`} size="lg">
        {logs?.loading ? (
          <CardSkeleton />
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <div className="text-xs text-text-muted">
              {logs?.stats?.requests ?? 0} request · {logs?.stats?.errors ?? 0} error · pertama{" "}
              {fmtDate(logs?.stats?.firstAt)} · terakhir {fmtDate(logs?.stats?.lastAt)}
            </div>
            {(logs?.details || []).length === 0 ? (
              <div className="text-text-muted">Belum ada traffic tercatat untuk key ini.</div>
            ) : (
              <div className="flex flex-col max-h-[50vh] overflow-y-auto">
                {(logs?.details || []).map((d) => (
                  <div key={d.id} className="flex flex-wrap gap-x-3 gap-y-1 border-b border-border-subtle py-2 last:border-b-0 text-xs">
                    <span className="text-text-muted">{fmtDate(d.timestamp)}</span>
                    <span className="font-mono">{d.model || "—"}</span>
                    <Badge variant={(d.status ?? 0) >= 400 ? "error" : "success"} size="sm">
                      {d.status ?? "—"}
                    </Badge>
                    <span className="text-text-muted">
                      {d.tokens?.input ?? d.tokens?.prompt ?? 0} in / {d.tokens?.output ?? d.tokens?.completion ?? 0} out
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal isOpen={!!testResult} onClose={() => setTestResult(null)} title={`Tes key — ${testResult?.name || ""}`} size="sm">
        <div className="flex flex-col gap-3 text-sm">
          <div className="text-xs text-text-muted font-mono">{testResult?.keyDisplay}</div>
          {(testResult?.out || []).map((row) => (
            <div key={row.label} className="flex flex-col gap-1 rounded border border-border-subtle bg-surface-2 p-2">
              <div className="flex items-center gap-2">
                <Badge variant={row.ok ? "success" : "error"} size="sm">
                  {row.ok ? "OK" : "GAGAL"}
                </Badge>
                <span className="font-mono text-xs">{row.label}</span>
              </div>
              <div className="text-xs text-text-muted">{row.detail}</div>
            </div>
          ))}
          <div className="text-xs text-text-muted">
            Ini dua panggilan pertama yang buyer lakukan. Kalau dua-duanya OK, key-nya siap dikirim.
          </div>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Konfirmasi"}
        message={confirmState?.message}
        confirmText={confirmState?.confirmText || "Lanjut"}
        loading={busy}
      />
    </div>
  );
}
