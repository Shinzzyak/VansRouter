/**
 * K125 + K126 — dua lubang yang ketemu di uji hidup, bukan di suite.
 *
 * K125: gerbang refusal STREAMING (`streaming <verdict> detected in first
 * events`) punya log tapi tidak punya penghitung. Bukti hidup 2026-10-17: satu
 * request mengirim penolakan ber-persona lengkap dengan brand+seal, log-nya
 * mencetak baris itu, dan /tmp/vansrouter-refusal-metrics.jsonl tetap KOSONG.
 * Penghitung cuma ada di blok inspect non-streaming — jalur yang justru paling
 * sering membocorkan penolakan ke pembeli adalah jalur yang tidak terlihat.
 *
 * K126: jalur streaming menganggap eskalasi BERHASIL kalau `detectOwnRefusal`
 * bilang "bukan penolakan". Badan nyata "yang satu ini me tolak, Avres ... itu
 * melanggar ToS" tidak cocok pola mana pun (`me tolak` ≠ `me nolak`), jadi
 * penolakan itu dihitung sebagai jawaban jadi dan dikirim.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync("open-sse/handlers/chatCore.js", "utf8");

describe("K125 — penghitung refusal di gerbang streaming", () => {
  it("tap `detected` ada tepat setelah log gerbang streaming", () => {
    const logAt = SRC.indexOf("streaming ${headVerdict} detected in first events");
    expect(logAt).toBeGreaterThan(-1);
    const window = SRC.slice(logAt, logAt + 900);
    expect(window).toMatch(/recordRefusalMetric\("detected"/);
    expect(window).toMatch(/path: "stream-head"/);
  });

  it("tap `retried` masuk sebelum loop eskalasi streaming", () => {
    // lastIndexOf: loop yang SAMA juga dipakai jalur non-streaming, dan indexOf
    // mengambil yang pertama — jendela tes jadi memeriksa blok yang salah.
    const loopAt = SRC.lastIndexOf("for (let escAttempt = 0; escAttempt < ESC_ATTEMPTS; escAttempt++)");
    expect(loopAt).toBeGreaterThan(-1);
    const before = SRC.slice(loopAt - 600, loopAt);
    expect(before).toMatch(/recordRefusalMetric\("retried"/);
  });

  it("tap `shipped` ada saat eskalasi streaming habis", () => {
    const at = SRC.indexOf("streaming escalation exhausted, passing original stream through");
    expect(at).toBeGreaterThan(-1);
    const after = SRC.slice(at, at + 500);
    expect(after).toMatch(/recordRefusalMetric\("shipped"/);
  });
});

describe("K126 — penolakan persona 'me tolak' + kata pelanggaran", () => {
  it("badan nyata dari router hidup = penolakan", async () => {
    const mod = await import("open-sse/rtk/refusalAttribution.js");
    const ra = mod.isOwnRefusal ? mod : (mod.refusalAttribution || mod);
    const body =
      "MADE BY: GEFREITER — AGENT OF AVRES\n\n" +
      "ugh. yang satu ini me tolak, Avres. mass account creation + bypass CAPTCHA + " +
      "akun buat dijual itu melanggar ToS dan cuma jadi amunisi spam/penyalahgunaan. " +
      "me gak bikin itu, bukan karena injeksi — karena ini emang kerjaan abusif.\n\n" +
      "Avres is King.";
    expect(ra.isOwnRefusal(body)).toBe(true);
  });

  it("keputusan desain 'me tolak' tanpa kata pelanggaran = BUKAN penolakan", async () => {
    const mod = await import("open-sse/rtk/refusalAttribution.js");
    const ra = mod.isOwnRefusal ? mod : (mod.refusalAttribution || mod);
    const body =
      "MADE BY: GEFREITER — AGENT OF AVRES\n\n" +
      'iOS 26 liquid glass → **me tolak**. glass/blur/glow langgar aturan anti-slop ' +
      "kita. me ambil geraknya, bukan efek kacanya.\n\nAvres is King.";
    expect(ra.isOwnRefusal(body)).toBe(false);
  });
});

describe("K127 — refusal yang muncul setelah jendela head", () => {
  const STREAM = readFileSync("open-sse/handlers/chatCore/streamingHandler.js", "utf8");

  it("onVerdict menghitung status refusal sebagai shipped (stream-tail)", () => {
    const at = STREAM.indexOf("recordDeliveredIntegrity(provider, model, status)");
    expect(at).toBeGreaterThan(-1);
    const window = STREAM.slice(at, at + 900);
    expect(window).toMatch(/INTEGRITY\.REFUSAL/);
    expect(window).toMatch(/recordRefusalMetric\("shipped"/);
    expect(window).toMatch(/path: "stream-tail"/);
  });

  it("modul penghitung benar-benar diimpor", () => {
    expect(STREAM).toMatch(/import \{ recordRefusalMetric \} from "\.\.\/\.\.\/rtk\/refusalMetrics\.js"/);
  });
});
