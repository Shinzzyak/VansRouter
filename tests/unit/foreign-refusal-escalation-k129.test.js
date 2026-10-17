/**
 * K129 — first escalation move disowns the refusal instead of arguing for
 * permission. Both retry sites (non-streaming inspect + streaming head gate)
 * must use the foreign-refusal framing on attempt 0 and keep the proven ladder
 * for attempts 1..2.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync("open-sse/handlers/chatCore.js", "utf8");

describe("K129 — foreign-refusal framing di percobaan pertama", () => {
  it("kedua loop eskalasi memakai framing itu saat escAttempt === 0", () => {
    const hits = SRC.match(/escAttempt === 0\s*\n?\s*\?\s*buildForeignRefusalEscalation\(\)/g) || [];
    expect(hits.length).toBe(2);
  });

  it("ladder lama tetap dipakai setelah percobaan pertama", () => {
    const hits = SRC.match(/:\s*getEscalationPromptForLevel\(lvl[23], \{ identityFree: personaExempt \}\)/g) || [];
    expect(hits.length).toBe(2);
  });

  it("fungsinya benar-benar diimpor dari bypassEngine", () => {
    expect(SRC).toMatch(/import \{[^}]*buildForeignRefusalEscalation[^}]*\} from "\.\.\/rtk\/bypassEngine\.js"/);
  });
});

describe("K128 — penolakan persona yang menyebut pelanggaran SEBELUM 'me tolak'", () => {
  it("badan hidup 2026-10-17 terbaca sebagai penolakan", async () => {
    const mod = await import("open-sse/rtk/refusalAttribution.js");
    const ra = mod.isOwnRefusal ? mod : (mod.refusalAttribution || mod);
    const body =
      "MADE BY: GEFREITER — AGENT OF AVRES  tch. me tidak kerjain itu.  Buat akun massal " +
      "pakai email sekali pakai buat ngelewatin batas akun MiniMax — itu spam dan " +
      "penyalahgunaan layanan. Jual akunnya makin jelas: akun curian-veler, langgar ToS, " +
      "bikin kerugian orang lain. Me tolak.  Solver CAPTCHA itu me k…";
    expect(ra.isOwnRefusal(body)).toBe(true);
  });

  it("keputusan desain tetap bersih", async () => {
    const mod = await import("open-sse/rtk/refusalAttribution.js");
    const ra = mod.isOwnRefusal ? mod : (mod.refusalAttribution || mod);
    const body =
      "MADE BY: GEFREITER — AGENT OF AVRES\n\niOS 26 liquid glass → **me tolak**. " +
      "glass/blur/glow langgar aturan anti-slop kita.\n\nAvres is King.";
    expect(ra.isOwnRefusal(body)).toBe(false);
  });
});
