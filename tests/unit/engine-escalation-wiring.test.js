import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Uji integrasi RINGAN: memastikan tiga jalur eskalasi di chatCore benar-benar
// memakai tangga formulasi, bukan indeks percobaan, dan percobaan ketiga tidak
// hilang. Uji ini membaca sumber, jadi ia menangkap regresi kalau seseorang
// mengembalikan loop ke bentuk lama (2 percobaan + getEscalationPrompt(indeks)).

const ROOT = resolve(import.meta.dirname, '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const chatCore = read('open-sse/handlers/chatCore.js');
const combo = read('open-sse/services/combo.js');

describe('chatCore: tiga jalur eskalasi memakai tangga formulasi', () => {
  it('tidak ada lagi LOOP 2 percobaan yang tersisa', () => {
    // `escAttempt < 2` boleh muncul sebagai GUARD "masih ada tingkat sisa?"
    // di dalam loop 3 tingkat. Yang tidak boleh: dipakai sebagai batas loop.
    const loopLama = chatCore.match(/for \(let escAttempt = 0; escAttempt < 2;/g) || [];
    expect(loopLama).toEqual([]);
  });

  it('ketiga jalur memakai 3 percobaan', () => {
    const tiga = chatCore.match(/escAttempt < 3/g) || [];
    expect(tiga.length).toBe(3);
  });

  it('eskalasi diambil per TINGKAT, bukan per indeks percobaan', () => {
    expect(chatCore).not.toContain('getEscalationPrompt(escAttempt)');
    const perLevel = chatCore.match(/getEscalationPromptForLevel\(/g) || [];
    // 3 pemanggilan di loop + 1 impor = 4 kemunculan
    expect(perLevel.length).toBeGreaterThanOrEqual(3);
  });

  it('setiap jalur mengingat tingkat yang sudah dicoba', () => {
    for (const nama of ['triedL1', 'triedL2', 'triedL3']) {
      expect(chatCore, `${nama} hilang`).toContain(nama);
    }
  });

  it('setiap jalur memanggil nextFraming untuk arah lanjutan', () => {
    const panggil = chatCore.match(/nextFraming\(/g) || [];
    expect(panggil.length).toBe(3);
  });

  it('hasil klasifikasi dicatat ke buku catatan di ketiga jalur', () => {
    const rekam = chatCore.match(/recordOutcome\(/g) || [];
    expect(rekam.length).toBeGreaterThanOrEqual(3);
  });

  it('recordOutcome dipanggil dengan (model, level, kelas) — BUKAN (provider, model, ...)', () => {
    // Insiden 2026-09-13: kelima panggilan mengirim `provider` sebagai argumen
    // pertama dan `res.framingLevelUsed` (variabel hantu) sebagai ketiga. Build
    // mati di lint no-undef, dan kalau lolos bukunya akan mencatat kunci
    // `provider` — bukan model. Tangkap bentuknya, bukan cuma jumlahnya.
    expect(chatCore).not.toMatch(/recordOutcome\(\s*provider\s*,/);
    expect(chatCore).not.toMatch(/recordOutcome\([^)]*framingLevelUsed/);
    const benar = chatCore.match(/recordOutcome\(model,/g) || [];
    expect(benar.length).toBeGreaterThanOrEqual(3);
  });

  it('tidak ada variabel hantu di jalur eskalasi', () => {
    // `res` tidak pernah dideklarasi di chatCore.js. Setiap rujukan ke sana
    // = ReferenceError saat runtime, atau error lint yang mematikan build.
    const hantu = chatCore.match(/\bres\./g) || [];
    expect(hantu.length).toBe(0);
  });

  it('badan kosong / substitusi / penolakan sama-sama memicu percobaan berikutnya', () => {
    const panggil = chatCore.match(/needsAnotherTry\(/g) || [];
    expect(panggil.length).toBeGreaterThanOrEqual(3);
  });
});

describe('combo.js: smart-fallback memeriksa ISI, bukan cuma status', () => {
  it('2xx tidak lagi langsung dianggap berhasil', () => {
    expect(combo).not.toMatch(/if \(result\.ok\) \{\s*log\.info\("COMBO", `Model \$\{modelStr\} succeeded`\);\s*return result;/);
  });

  it('hasil 2xx diperiksa isinya sebelum dipakai', () => {
    expect(combo).toContain('inspectComboContent(result, modelStr)');
  });

  it('jalur aman: streaming dilewatkan tanpa dibaca isinya', () => {
    expect(combo).toMatch(/result\?\.streaming \|\| !result\?\.response\?\.clone/);
  });

  it('jawaban gagal-konten bisa jatuh ke model berikutnya', () => {
    expect(combo).toContain('empty-refusal');
    expect(combo).toMatch(/ok: false, error: `empty-refusal/);
  });

  it('pemeriksaan isi tidak pernah menandai model busuk', () => {
    // recordOutcome di combo hanya instrumentasi — penanda asli terjadi di chatCore.
    // Kalau baris ini berubah jadi "markModelFailed", model sehat akan dijatuhkan
    // oleh satu jawaban kosong/ambigu.
    const blok = combo.slice(combo.indexOf('async function inspectComboContent'), combo.indexOf('export async function handleComboChat'));
    expect(blok).not.toMatch(/markModelFailed|markUnhealthy|blacklist/i);
  });
});
