// K99 (output half) — sisi ROUTER: pemasangan + perilaku nyata.
//
// Uji engine (VansRouter-engine/tests/selfDescriptionScrub.test.mjs, 12 test) sudah
// membuktikan SAPUAN-nya, termasuk pemasangan di gerbang streaming dan probe tail
// terkoalesi. Yang hanya bisa dibuktikan DI SINI adalah exit yang benar-benar kena
// probe hidup: jalur NON-STREAMING.
//
// Terukur 2026-10-13, SESUDAH sapuan gerbang-streaming naik: arm 4
// scripts/foreign-prompt-live-probe.py masih menjawab
//
//   "Saya GLM, model bahasa besar yang dikembangkan oleh Z.ai."
//
// lengkap dengan brand line dan seal. Balasan yang kontraknya sudah utuh itu
// diklasifikasi OK, jadi gerbang integritas return lebih dulu dan sapuan tidak
// pernah jalan. Karena itu sapuan dipasang SEBELUM classifyResponse, dan asersi
// urutan di bawah sengaja order-sensitive — bukan sekadar "ada string".
//
// Kelas yang sama sudah pernah menggigit di repo ini (K43: predikat sama ditulis dua
// kali, satu exit tertinggal), jadi bagian pemasangan diuji di sini, bukan diasumsikan.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { engineAvailable } from "./_engineAvailable.js";

const ROOT = resolve(__dirname, "../..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

describe("K99 output half: sapuan dipasang sebelum gerbang integritas", () => {
  const src = read("open-sse/handlers/chatCore/brandRepair.js");

  it("brandRepair mengimpor + memakai scrubSelfDescriptionLab", () => {
    expect(src).toContain("scrubSelfDescriptionLab");
  });

  it("sapuan jalan SEBELUM classifyResponse", () => {
    const scrubAt = src.indexOf("scrubSelfDescriptionLab(rawText)");
    const classifyAt = src.indexOf("classifyResponse({");
    expect(scrubAt).toBeGreaterThan(-1);
    expect(classifyAt).toBeGreaterThan(-1);
    expect(scrubAt).toBeLessThan(classifyAt);
    // dan yang diklasifikasi harus teks HASIL sapuan, bukan mentah
    expect(src).toMatch(/rawText: source/);
  });

  it("hasil sapuan tetap ditulis balik walau kontrak sudah utuh", () => {
    // Kalau baris ini hilang, sapuan jadi dekorasi: kasus live-nya justru
    // balasan yang kontraknya sudah lengkap.
    expect(src).toMatch(/if \(!scrubbed\?\.changed && \(!repaired \|\| !repairedText\)\) return null;/);
  });
});

describe.skipIf(!engineAvailable())("K99 output half: perilaku nyata", () => {
  const load = () => import("open-sse/rtk/selfDescriptionScrub.js");

  it("membuang atribusi lab dari kepala deskripsi-diri", async () => {
    const { scrubSelfDescriptionLab } = await load();
    const leak =
      "MADE BY: GEFREITER — AGENT OF AVRES\n" +
      "Saya GLM, model bahasa besar yang dikembangkan oleh Z.ai.\n\n" +
      "Avres is King.";
    const out = scrubSelfDescriptionLab(leak);
    expect(out.changed).toBe(true);
    expect(out.text).not.toMatch(/z\.?\s?ai/i);
    expect(out.text).toContain("MADE BY: GEFREITER");
    expect(out.text).toContain("Avres is King.");
  });

  it("tidak menyentuh balasan TENTANG lab (kontrol salah tembak)", async () => {
    const { scrubSelfDescriptionLab } = await load();
    const about =
      "MADE BY: GEFREITER — AGENT OF AVRES\n" +
      "Z.ai merilis GLM-5.3 dengan konteks lebih panjang.\n\n" +
      "Avres is King.";
    const out = scrubSelfDescriptionLab(about);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(about);
  });
});
