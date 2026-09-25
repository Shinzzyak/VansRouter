// Bukti: `nextFraming()` mengembalikan OBJEK, dan tiga jalur eskalasi memakainya
// sebagai STRING.
//
// Terukur di ledger hidup 2026-09-25 (`data/engine-state.json`):
//
//   "deepseek-v4-1-flash": {
//      "wins":  {"T2": 29},
//      "tries": {"T2": 237, "[object Object]": 40},   <-- 40 kunci sampah
//      "lastLevel": "T2", "lastKelas": "SENYAP", "n": 277
//   }
//
// `recordOutcome(model, level, ...)` memakai `level` sebagai KUNCI objek, jadi
// objek apa pun menjadi "[object Object]". Dan `getEscalationPromptForLevel(level)`
// adalah `switch` dengan `default` -> T2, jadi objek apa pun menghasilkan prompt T2.
//
// Akibatnya BUKAN sekadar ledger kotor: arah lanjutan yang dihitung oleh
// nextFraming() — T1 untuk SENYAP, T3 untuk FILTER_UPSTREAM — DIBUANG, dan ketiga
// percobaan mengirim T2. Persis bug "tiga tingkat berbeda jadi tiga kali tingkat
// sama" yang pernah diperbaiki di jalur lain; ini kemunculan keduanya, dan yang
// pertama tidak tertangkap karena tesnya menghitung PEMANGGILAN, bukan bentuk
// argumen yang keluar.
//
// Tes ini menahan bentuknya, bukan jumlahnya: yang diperiksa adalah NILAI yang
// benar-benar sampai ke appendEscalationToBody.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const chatCore = readFileSync(resolve(ROOT, "open-sse/handlers/chatCore.js"), "utf8");

describe("nextFraming: hasilnya harus di-UNWRAP sebelum dipakai sebagai level", () => {
  it("nextFraming mengembalikan objek, jadi call site tidak boleh memakai hasilnya langsung", () => {
    // Semua tiga jalur: `lvlN = nextFraming(...) || lvlN` adalah bentuk yang SALAH,
    // karena menugaskan objek ke variabel yang harusnya string level.
    const salah = chatCore.match(/lvl\d\s*=\s*nextFraming\([^)]*\)\s*\|\|\s*lvl\d/g) || [];
    expect(
      salah,
      `tiga jalur eskalasi menugaskan objek ke variabel level:\n${salah.join("\n")}`
    ).toEqual([]);
  });

  it("hasilnya diambil .level-nya, dengan fallback ke level sekarang", () => {
    const benar = chatCore.match(/lvl\d\s*=\s*nextFraming\([^)]*\)\?\.\s*level\s*\?\?\s*lvl\d/g) || [];
    expect(benar.length, "ketiga jalur harus unwrap .level").toBe(3);
  });

  it("level yang dicatat ke ledger selalu string T1/T2/T3", () => {
    // Penjaga langsung terhadap "[object Object]" di ledger: setiap nilai yang
    // dikirim ke recordOutcome sebagai `level` harus berasal dari variabel yang
    // di-unwrap, bukan dari hasil nextFraming mentah.
    expect(chatCore).not.toMatch(/recordOutcome\(model,\s*nextFraming/);
  });
});
