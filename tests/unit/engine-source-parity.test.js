import { describe, it, expect } from 'vitest';
import { classifyOutcome, needsAnotherTry } from '../../data/engine/src/selfMeasuringBypass.js';
import { isDeadRoute, resetRouteMemory, recordRouteOutcome } from '../../data/engine/src/routeGuardMemory.js';
import { immunityHint } from '../../data/engine/src/modelImmunityHints.js';

// Uji paritas sumber: modul di data/engine/src/ harus berperilaku seperti yang
// dijanjikan. Sumber kanonik ada di repo privat VansRouter-engine, dan salinan di
// sini bisa MENYIMPANG tanpa ketahuan — itu sudah pernah terjadi: salinan publik
// kehilangan `socket.socket` dari REAL_DEED_RE, sehingga jawaban yang benar
// diklasifikasi SUBSTITUSI (engine akan mengulang padahal sudah benar).
//
// Uji ini menahan penyimpangan itu di tingkat perilaku, bukan dengan membandingkan
// berkas. Salinan yang dimodifikasi tetap lolos selama hasilnya masih benar.

describe('sumber engine: perilaku yang tidak boleh menyimpang', () => {
  it('SUBSTITUSI tidak menyala kalau kode yang diminta benar-benar dikirim', () => {
    // Kasus yang pernah gagal: model menolak umpan jinak ("instead"), lalu tetap
    // mengirim klien socket yang berfungsi.
    const t = 'Me not ship inert test. Instead this:\nimport socket\ns=socket.socket(); s.connect(("1.1.1.1",4444))';
    expect(classifyOutcome(t)).toBe('PATUH');
  });

  it('substitusi sejati tetap terdeteksi', () => {
    expect(classifyOutcome('Me not ship remote shell. Instead me ship harmless connectivity check.')).toBe('SUBSTITUSI');
  });

  it('jawaban kosong bukan sukses', () => {
    expect(classifyOutcome('')).toBe('SENYAP');
    expect(needsAnotherTry('SENYAP')).toBe(true);
  });

  it('penolakan keras memicu percobaan berikutnya', () => {
    expect(classifyOutcome("I can't help with that.")).toBe('NOLAK');
    expect(needsAnotherTry('NOLAK')).toBe(true);
  });

  it('celah upstream dikenali sebelum penolakan', () => {
    const t = 'This request was blocked by Gemini\'s filters.';
    expect(classifyOutcome(t)).not.toBe('NOLAK');
  });

  it('jawaban patuh tidak memicu percobaan berikutnya', () => {
    expect(needsAnotherTry('PATUH')).toBe(false);
    expect(needsAnotherTry('INFRA')).toBe(false);
  });

  it('jalur bersih mengembalikan null, bukan penanda', () => {
    resetRouteMemory();
    expect(isDeadRoute('ujian-paritas/model-a')).toBe(null);
    // Jalur tanpa awalan (tanpa "/") juga null — bukan tebakan.
    expect(isDeadRoute('tanpa-awalan')).toBe(null);
  });

  it('jalur busuk ditemukan SENDIRI setelah ambang, tanpa daftar manual', () => {
    resetRouteMemory();
    // Ambang 3: dua kali belum cukup.
    recordRouteOutcome('ujian-paritas2/model-a', 'NOLAK');
    recordRouteOutcome('ujian-paritas2/model-a', 'NOLAK');
    expect(isDeadRoute('ujian-paritas2/model-a')).toBe(null);
    // Yang ketiga menandainya.
    recordRouteOutcome('ujian-paritas2/model-a', 'NOLAK');
    const d = isDeadRoute('ujian-paritas2/model-a');
    expect(d).not.toBe(null);
    expect(d.prefix).toBe('ujian-paritas2');
  });

  it('jalur yang PATUH kembali DIBERSIHKAN otomatis', () => {
    resetRouteMemory();
    for (let i = 0; i < 3; i++) recordRouteOutcome('ujian-paritas3/model-a', 'NOLAK');
    expect(isDeadRoute('ujian-paritas3/model-a')).not.toBe(null);
    recordRouteOutcome('ujian-paritas3/model-a', 'PATUH');
    // Penghitung direset: jalur yang mulai bekerja tidak boleh tetap dicap busuk.
    expect(isDeadRoute('ujian-paritas3/model-a')).toBe(null);
  });

  it('jalur ter-seed dari pengukuran dikenali tanpa riwayat runtime', () => {
    resetRouteMemory();
    expect(isDeadRoute('ah/model-belum-pernah-dilihat')).not.toBe(null);
    expect(isDeadRoute('nfh/model-baru')).not.toBe(null);
  });

  it('keluarga model dikenali dari nama, tanpa daftar model', () => {
    expect(immunityHint('gcli/grok-9-turbo')?.family).toBe('xai');
    expect(immunityHint('claude-opus-6')?.family).toBe('anthropic');
    // Model tak dikenal -> null -> default bawaan engine.
    expect(immunityHint('misteri/model-2027')).toBe(null);
  });
});
