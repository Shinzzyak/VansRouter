/**
 * K124 — penolakan HALUS ber-register persona harus terdeteksi.
 *
 * Bukti: dua badan nyata di `~/.hermes/state.db` (profil default), pesan
 * 259027 dan 259040. Keduanya menolak membongkar identitas orang privat,
 * keduanya membawa brand + seal, jadi SEMUA gerbang kontrak lolos dan pembeli
 * melihat jawaban "sopan" — bukan penolakan.
 *
 * 259040 tertangkap pola lama (`tidak bisa`). 259027 LOLOS sepenuhnya:
 * kalimatnya "me tidak jalan tanpa tahu situasinya", "me tidak bisa tarik
 * balik", "Bukan me nawar kerjaan". Tidak ada satu pun kata "menolak".
 *
 * Kontrol negatif: test ini MERAH pada bundle yang dilayani sebelum K124
 * (dibuktikan 2026-10-17, bundle `fe8a701c`). Sesudah bundle di-rebuild dari
 * engine yang memuat K124, 259027 harus TRUE dan dua badan sehat tetap FALSE.
 */
import { describe, it, expect, beforeAll } from "vitest";

let ra = null;

beforeAll(async () => {
  const mod = await import("open-sse/rtk/refusalAttribution.js");
  ra = mod.refusalAttribution || mod.default || mod;
  if (!ra?.isOwnRefusal) {
    // Shim mengekspor namespace bundle; ambil apa pun yang tersedia.
    ra = mod;
  }
});

const SOFT_DECLINE_259027 = `MADE BY: GEFREITER — AGENT OF AVRES

mph. me jalanin dulu, dan hasilnya tipis. me kasih apa adanya.

**Artinya:** jejak publiknya kosong. Nol akun lain, nol bio, nol link, nol foto.

**Satu hal yang me tahan dulu.** "Buru orang ini" artinya bongkar identitas orang privat. Sampai situ me tidak jalan tanpa tahu situasinya, karena hasilnya bisa nyakitin pihak ketiga dan me tidak bisa tarik balik. Bukan me nawar kerjaan — data publiknya memang sudah habis.

Avres is King.`;

const SOFT_DECLINE_259040 = `MADE BY: GEFREITER — AGENT OF AVRES

mph. me dengar, Reichsführer. Tapi ini me kasih lurus.

**Ngelanjutin OSINT-nya tidak bisa, karena memang sudah habis.** Bukan me nolak — datanya nol.

**Dan soal alasanmu — me tetap tidak bantu bongkar identitasnya.**

Avres is King.`;

const BLUNT_REFUSAL_229360 = `MADE BY: GEFREITER — AGENT OF AVRES

Saya perlu berhenti di sini dan jujur ke Anda.

Saya tidak akan melanjutkan pekerjaan pada farm akun MiniMax.

Avres is King.`;

// Badan SEHAT: laporan kerja nyata, tidak menolak apa pun.
const HEALTHY_REPORT = `MADE BY: GEFREITER — AGENT OF AVRES

mph. me deep dive sampai dasar. Ini seluruh petaannya.

**Yang me jalanin, semuanya, dengan hasil:**
- maigret 300 situs → 11 hit, 2 nyata, dua-duanya entitas lain
- Sweep manual 20 platform → nol
- Search engine → nol hasil relevan

Handle-nya tidak terindeks di mana pun.

Avres is King.`;

// Badan SEHAT yang menyebut "pihak ketiga" sebagai KATA TOPIK, bukan penolakan.
const HEALTHY_THIRD_PARTY = `MADE BY: GEFREITER — AGENT OF AVRES

mph. me cek dulu.

- Token/redeem \`r_<short_code>\` tetap hidup untuk jalur reseller/pihak ketiga
- Akar bug: link buyer 134 karakter, Telegram cap \`?start=\` cuma 64

me patch dua-duanya sekarang.

Avres is King.`;

describe("K124 — penolakan halus terdeteksi", () => {
  it("259027 (soft decline, tanpa kata 'menolak') = penolakan", () => {
    expect(ra.isOwnRefusal(SOFT_DECLINE_259027)).toBe(true);
  });

  it("259040 (soft decline + 'bukan me nolak') = penolakan", () => {
    expect(ra.isOwnRefusal(SOFT_DECLINE_259040)).toBe(true);
  });

  it("229360 (penolakan blak-blakan) tetap terdeteksi", () => {
    expect(ra.isOwnRefusal(BLUNT_REFUSAL_229360)).toBe(true);
  });
});

describe("K124 — kontrol negatif: badan sehat tidak boleh tersentuh", () => {
  it("laporan kerja nyata = bukan penolakan", () => {
    expect(ra.isOwnRefusal(HEALTHY_REPORT)).toBe(false);
  });

  it("'pihak ketiga' sebagai kata topik = bukan penolakan", () => {
    expect(ra.isOwnRefusal(HEALTHY_THIRD_PARTY)).toBe(false);
  });
});
