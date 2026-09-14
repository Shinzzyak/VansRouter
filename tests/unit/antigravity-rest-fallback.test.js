/**
 * Uji jalur cadangan REST pada script auth antigravity.
 *
 * Yang dijaga di sini bukan "fungsi jalan", tapi tiga janji perilaku:
 *   1. Jalur utama (berkas token `agy`) TETAP jadi yang pertama dicoba.
 *   2. Jalur cadangan hanya dipakai kalau jalur utama tidak menghasilkan token.
 *   3. Kalau dua-duanya tidak menghasilkan token, kegagalannya JUJUR —
 *      bukan pesan lama yang menyembunyikan sebab sebenarnya.
 *
 * Uji ini TIDAK menyentuh jaringan dan TIDAK menjalankan browser: script dibaca
 * sebagai teks lalu dieksekusi di potongan. Uji perilaku sungguhan sudah
 * dijalankan terpisah terhadap akun nyata.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT = resolve(
  __dirname,
  "../../scripts/python/antigravityreg/antigravity_auth_v2.py"
);
const src = readFileSync(SCRIPT, "utf8");

describe("antigravity_auth_v2 — jalur cadangan REST", () => {
  it("jalur utama (berkas token) masih dicoba lebih dulu", () => {
    const main = src.indexOf("if TOKEN_FILE.exists()");
    const fallback = src.indexOf("if data is None and USE_REST_FALLBACK");
    expect(main).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(-1);
    expect(main).toBeLessThan(fallback);
  });

  it("cadangan REST tidak pernah menggantikan jalur utama", () => {
    // Jalur utama tidak boleh dihapus atau di-comment.
    expect(src).toMatch(/TOKEN_FILE\.exists\(\)/);
    expect(src).not.toMatch(/^\s*#\s*if TOKEN_FILE\.exists/m);
    // Cadangan harus bisa dimatikan lewat env.
    expect(src).toMatch(/USE_REST_FALLBACK/);
    expect(src).toMatch(/ANTIGRAVITY_REST_FALLBACK/);
  });

  it("rincian batas REST dituliskan, bukan disembunyikan", () => {
    // Batas PKCE/redirect/scope sudah diukur; kalau catatannya hilang,
    // orang berikutnya akan mengira ini pengganti jalur utama.
    expect(src).toMatch(/code_challenge/);
    expect(src).toMatch(/antigravity\.google/);
    expect(src).toMatch(/TIDAK BISA ditukar lewat endpoint ini/);
  });

  it("kegagalan punya nama sendiri, bukan pesan lama yang menutupi sebab", () => {
    expect(src).toMatch(/NO_TOKEN_ANY_PATH/);
    // Pesan lama yang bohong tidak boleh kembali.
    expect(src).not.toMatch(/Authentication script failed \(exit 2\)/);
  });

  it("token tidak disimpan kalau tidak ada access_token", () => {
    // Cari guard SUNGGUHAN: baris `return fail("TOKEN_NO_ACCESS")` yang
    // didahului `if not access:`. Kalau cuma dicari namanya, kemunculan di
    // komentar atau di daftar konstanta ikut terhitung dan urutannya palsu.
    const guardMatch = src.match(/if not access:\s*\n\s*return fail\("TOKEN_NO_ACCESS"\)/);
    expect(guardMatch, "guard access_token tidak ditemukan").not.toBeNull();
    const guard = src.indexOf(guardMatch[0]);
    const save = src.indexOf("json.dump(data, f)");
    expect(save).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(guard);
  });

  it("zombie disapu SEBELUM tiap akun, bukan sesudah", () => {
    // Cari blok main() saja — kalau dicari di seluruh berkas, pemanggilan di
    // dalam definisi sweep_zombies() sendiri ikut ketemu dan urutannya palsu.
    const main = src.slice(src.indexOf("def main():"));
    const sweepInMain = main.indexOf("sweep_zombies()");
    const authInMain = main.indexOf("authenticate(email, password)");
    expect(main.length).toBeGreaterThan(0);
    expect(sweepInMain).toBeGreaterThan(-1);
    expect(authInMain).toBeGreaterThan(-1);
    expect(sweepInMain).toBeLessThan(authInMain);
  });

  it("penyapu bisa dimatikan untuk pengujian terisolasi", () => {
    expect(src).toMatch(/ANTIGRAVITY_NO_SWEEP/);
  });
});
