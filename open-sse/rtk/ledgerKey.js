// K173 — satu kunci ledger per JALUR, dan jalur itu harus stabil lintas
// permintaan.
//
// Kenapa berkas ini ada. Ledger bypass menulis dengan `recordOutcome(model,
// level, kelas, routeId)` dan K171 memutuskan bahwa `routeId` adalah identitas
// saat MENULIS — jadi apa pun yang dikirim call-site menjadi kunci baris.
// Masalahnya dua penulis memakai dua ejaan berbeda untuk jalur yang sama:
//
//   combo.js   menulis `skg/z-ai/glm-5.3-flash`      (alias dari providerNodes.prefix)
//   chatCore   menulis `openai-compatible-chat-<uuid>/z-ai/glm-5.3-flash`
//                                                     (id koneksi mentah)
//
// Terukur dengan probe bundel produksi: 9 NOLAK lewat combo menghasilkan satu
// baris `skg/...` esc 9, lalu satu NOLAK lewat chatCore melahirkan baris KEDUA
// `openai-compatible-chat-.../...` esc 1. Eskalasi dipecah ke dua baris, tidak
// ada yang pernah mencapai anggaran 8, dan poros T4 tidak pernah dipanggil —
// persis gejala yang dilaporkan (esc 11, lastExplore 0, T4 tries 0).
//
// Aturan: kunci = `<prefix>/<model>` dengan prefix dari providerNodes, karena
// itulah ejaan yang dipakai combo, dashboard, dan nama model yang diketik
// klien. Id koneksi hanya dipakai kalau node tidak punya prefix.

import { getProviderNodeById } from "@/lib/db/repos/nodesRepo.js";

/**
 * Fungsi murni supaya bisa dites tanpa DB.
 * `prefix` kosong/null → jatuh ke providerId, bukan ke string kosong.
 */
export function ledgerKeyFrom(prefix, providerId, model) {
  const head = prefix || providerId || "";
  if (!head) return String(model || "");
  return `${head}/${model}`;
}

const prefixCache = new Map();

/**
 * Resolusi prefix per providerId, di-cache selamanya: providerNodes jarang
 * berubah dan satu permintaan tidak boleh menunggu SQL dua kali.
 */
export async function prefixFor(providerId) {
  if (!providerId) return null;
  if (prefixCache.has(providerId)) return prefixCache.get(providerId);
  let prefix = null;
  try {
    const node = await getProviderNodeById(providerId);
    if (node && typeof node.prefix === "string" && node.prefix.trim()) prefix = node.prefix.trim();
  } catch { /* DB tidak boleh menjatuhkan permintaan */ }
  // Cache juga hasil null: node tanpa prefix tidak akan punya prefix besok.
  prefixCache.set(providerId, prefix);
  return prefix;
}

/**
 * Kunci ledger stabil untuk satu permintaan.
 * `credentials` dipakai sebagai jalan pintas kalau DB tidak bisa dibaca —
 * beberapa executor membawa `providerSpecificData.prefix` hasil resolve.
 */
export async function ledgerKeyFor(providerId, model, credentials = null) {
  const inline = credentials?.providerSpecificData?.prefix || credentials?.prefix || null;
  const prefix = (await prefixFor(providerId)) || inline;
  return ledgerKeyFrom(prefix, providerId, model);
}

/** Untuk tes: lupakan cache. */
export function resetPrefixCache() {
  prefixCache.clear();
}
