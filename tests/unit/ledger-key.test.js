import { describe, it, expect } from "vitest";
import { ledgerKeyFrom, ledgerKeyFor, resetPrefixCache } from "../../open-sse/rtk/ledgerKey.js";

// K173 — kunci ledger harus SATU ejaan per jalur.
//
// Cacat yang dijaga tes ini: chatCore menulis `<id koneksi>/<model>` sementara
// combo menulis `<prefix>/<model>`. Dua baris untuk satu jalur = anggaran
// eksplorasi terpecah, T4 tidak pernah dipanggil. Tes ini mengunci fungsi
// pembentuk kunci, bukan pemanggilnya, supaya kedua penulis bisa memakai satu
// implementasi.

const UUID = "openai-compatible-chat-18e1c392-343f-443f-96eb-87b1eb8dee3d";

describe("ledgerKeyFrom", () => {
  it("uses the provider prefix, so chatCore and combo agree on one row", () => {
    expect(ledgerKeyFrom("skg", UUID, "z-ai/glm-5.3-flash")).toBe("skg/z-ai/glm-5.3-flash");
    // yang ditulis combo untuk jalur yang sama
    expect(ledgerKeyFrom("skg", UUID, "z-ai/glm-5.3-flash")).toBe("skg/z-ai/glm-5.3-flash");
  });

  it("falls back to the connection id when a node has no prefix", () => {
    expect(ledgerKeyFrom(null, UUID, "glm-5.3-flash")).toBe(`${UUID}/glm-5.3-flash`);
    expect(ledgerKeyFrom("", UUID, "glm-5.3-flash")).toBe(`${UUID}/glm-5.3-flash`);
  });

  it("never emits a leading slash when both are missing", () => {
    expect(ledgerKeyFrom(null, null, "glm-5.3-flash")).toBe("glm-5.3-flash");
  });
});

describe("ledgerKeyFor", () => {
  it("prefers the resolved prefix over the raw connection id", async () => {
    resetPrefixCache();
    const key = await ledgerKeyFor("static-provider-id", "z-ai/glm-5.3-flash", {
      providerSpecificData: { prefix: "skg" },
    });
    // provider statis tidak ada di providerNodes → prefix dari credentials dipakai
    expect(key).toBe("skg/z-ai/glm-5.3-flash");
  });

  it("still returns a usable key when nothing resolves", async () => {
    resetPrefixCache();
    const key = await ledgerKeyFor("unknown-id", "glm-5.3-flash", null);
    expect(key.endsWith("/glm-5.3-flash")).toBe(true);
  });
});
