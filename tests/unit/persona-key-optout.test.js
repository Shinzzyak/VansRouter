// Gerbang persona per-key — sisi ROUTER (bukan sisi engine).
//
// Uji engine (VansRouter-engine/tests/personaExempt.test.mjs) membuktikan
// registry-nya menghormati `personaInject: false`. Uji INI membuktikan dua hal
// yang hanya hidup di repo publik dan bisa hilang tanpa satu pun uji engine
// gagal:
//
//   1. jalur DATANYA — chat.js harus me-resolve key walau requireApiKey=false,
//      karena kalau tidak, flag-nya tidak pernah terbaca di mode lokal dan
//      gerbangnya mati tanpa gejala (bentuk K21: nilai disiapkan lalu tidak
//      pernah dibaca);
//   2. jalur BALASANNYA — brand gate streaming + repair non-streaming +
//      kolom DB + jalur update key.
//
// Semua asersi di sini berbasis PERILAKU atau sumber, tidak ada yang menghitung
// pemanggilan (kelas K3: tes yang menghitung call bukan memeriksa nilai).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

// ── 2. Jalur balasan: gate brand harus ikut menghormati flag ──────────────────

describe("persona opt-out: jalur balasan (gate brand)", () => {
  it("nonStreamingHandler tidak mereparasi brand untuk key exempt", () => {
    const src = read("open-sse/handlers/chatCore/nonStreamingHandler.js");
    expect(src).toContain("apiKeyInfo?.personaInject === false");
    // classify + chatSurface dua-duanya harus di-gate; satu saja bocor =
    // brand line pemilik ditempel ke balasan produk.
    expect(src).toMatch(/enforceBrand: !personaExempt/);
    expect(src).toMatch(/const chatSurface = !personaExempt/);
  });

  it("streamingHandler tidak memasang brand gate untuk key exempt", () => {
    const src = read("open-sse/handlers/chatCore/streamingHandler.js");
    expect(src).toContain("apiKeyInfo?.personaInject === false");
    expect(src).toMatch(/brandStreamEnforceEnabled\(\) && !wantsJsonOutput\(body\) && !personaExempt/);
    // Ledger tidak boleh diracuni: verdict SUBSTITUSI per balasan produk akan
    // menaikkan rasio kegagalan model yang sama untuk semua orang.
    expect(src).toMatch(/enforceBrand: !personaExempt/);
  });

  it("chatCore meneruskan apiKeyInfo ke registry dan ke tangga eskalasi", () => {
    const src = read("open-sse/handlers/chatCore.js");
    expect(src).toMatch(/applyPromptInjectors\(\{[\s\S]{0,900}?apiKeyInfo,/);
    const free = src.match(/identityFree: personaExempt/g) || [];
    expect(free.length).toBe(3); // tiga jalur eskalasi, bukan satu
  });
});

// ── 3. Kolom DB + jalur update ───────────────────────────────────────────────

describe("persona opt-out: kolom DB dan jalur update", () => {
  it("schema mendeklarasikan kolomnya (additive, default 1)", () => {
    const src = read("src/lib/db/schema.js");
    expect(src).toMatch(/personaInject: "INTEGER DEFAULT 1"/);
  });

  it("rowToKey fail-SAFE: hanya 0/false yang mengecualikan", () => {
    const src = read("src/lib/db/repos/apiKeysRepo.js");
    expect(src).toMatch(/personaInject: !\(row\.personaInject === 0 \|\| row\.personaInject === false\)/);
  });

  it("INSERT dan UPDATE menyertakan kolomnya (placeholder seimbang)", () => {
    const src = read("src/lib/db/repos/apiKeysRepo.js");
    const insStart = src.indexOf("INSERT INTO apiKeys(");
    // Stop at the closing backtick: the params array below contains a JS ternary
    // (`apiKey.personaInject ? 1 : 0`) whose `?` is not a bind placeholder.
    const ins = src.slice(insStart, src.indexOf("`", insStart));
    expect(ins).toContain("personaInject");
    // Seimbang = jumlah kolom == jumlah `?` VALUES. Tidak seimbang membuat
    // setiap pembuatan key error 500 (SQLite: bind lengkang) — bukan kegagalan
    // diam, tapi juga bukan sesuatu yang boleh berubah diam-diam.
    const colList = ins.slice(ins.indexOf("(") + 1, ins.indexOf(") VALUES("));
    const cols = colList.split(",").map((s) => s.trim()).filter(Boolean).length;
    const placeholders = ins.split("?").length - 1;
    expect(placeholders).toBe(cols);
    expect(cols).toBe(19);

    const updStart = src.indexOf("UPDATE apiKeys SET");
    const upd = src.slice(updStart, src.indexOf("`", updStart));
    expect(upd).toContain("personaInject = ?");
    const updPlaceholders = upd.split("?").length - 1;
    const updParams = src.slice(src.indexOf("[", src.indexOf("WHERE id = ?", updStart)), src.indexOf("]", src.indexOf("[", src.indexOf("WHERE id = ?", updStart))));
    // Trailing comma after the last param would count as an empty entry.
    const params = updParams.split(",").map((s) => s.trim()).filter(Boolean).length;
    expect(updPlaceholders).toBe(params);
    expect(updPlaceholders).toBe(18);
  });

  it("route PUT /api/keys/[id] menerima personaInject", () => {
    const src = read("src/app/api/keys/[id]/route.js");
    expect(src).toMatch(/"personaInject" in body/);
  });

  it("key BARU default-nya persona MENYALA (hanya false eksplisit yang mematikan)", () => {
    // Amunisi kontrak "key baru di masa depan inject persona lagi" (Avres,
    // 2026-09-30). Kalau ekspresi ini berubah jadi `!!limits.personaInject`,
    // semua key baru lahir tanpa identitas pemilik dan tidak ada uji lain yang
    // gagal — rowToKey tetap fail-SAFE untuk baris lama.
    const src = read("src/lib/db/repos/apiKeysRepo.js");
    expect(src).toMatch(
      /personaInject: limits\.personaInject === false \? false : true/
    );
    // Sisi DB juga default 1: kolom tanpa DEFAULT membaca NULL untuk key lama,
    // dan `NULL === false` = false = persona nyala; DEFAULT 1 membuat semantik
    // itu terlihat di skema, bukan cuma di ekspresi JS.
    const schema = read("src/lib/db/schema.js");
    expect(schema).toMatch(/personaInject: "INTEGER DEFAULT 1"/);
  });
});
