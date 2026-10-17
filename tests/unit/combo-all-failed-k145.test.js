// K145 — when every candidate fails, the CLIENT must not be told the first
// candidate's own status, and must never be shown the upstream's prose.
//
// Measured, not invented: during the 2026-10-17 K110b probe run the client got
//   HTTP 403  {"message":"[403]: {\"type\":\"error\",\"error\":{\"type\":\"FreeTierError\"…
//              \"OpenCode's free tier can only be used from within OpenCode\"
// for a `combo/smart-fallback` request that had simply run out of candidates.
// Two things were wrong with that answer:
//   1. STATUS — 403 blames the caller ("you are not allowed") for a provider
//      problem. The combo's own comment two lines above says 503 is the honest
//      code for "providers unavailable"; the first failure's status won instead.
//   2. TEXT — the upstream payload travelled verbatim to the buyer, naming the
//      provider and its URL. Same family as K99/K112: the router must not leak
//      where it gets its answers.
//
// Control: both arms below fail on the pre-K145 source (status 403, text carries
// "OpenCode"). Verified by stashing combo.js and re-running.
import { describe, it, expect, beforeEach } from "vitest";
import { handleComboChat, resetComboRotation } from "open-sse/services/combo.js";

const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const UPSTREAM_403 = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message:
      "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai",
  },
});

function bareResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers: { "Content-Type": "application/json", ...headers } });
}

async function runCombo(candidates) {
  const tried = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Ping" }], stream: false },
    models: Object.keys(candidates),
    handleSingleModel: async (_body, modelStr) => {
      tried.push(modelStr);
      return candidates[modelStr];
    },
    log: quietLog,
    comboName: `k145-${Math.random().toString(36).slice(2)}`,
    comboStrategy: "fallback",
    timeoutMs: 0,
  });
  const resp = typeof res?.text === "function" ? res : res?.response;
  const text = typeof resp?.text === "function" ? await resp.text() : "";
  return { tried, status: resp?.status, text };
}

beforeEach(() => resetComboRotation());

describe("K145: semua kandidat gagal ⇒ status jujur, teks hulu tidak bocor", () => {
  it("403 dari kandidat pertama TIDAK sampai ke klien sebagai 403", async () => {
    const { tried, status } = await runCombo({
      "a/opencode-free": bareResponse(UPSTREAM_403, { status: 403 }),
      "b/opencode-free": bareResponse(UPSTREAM_403, { status: 403 }),
    });
    expect(tried).toEqual(["a/opencode-free", "b/opencode-free"]);
    expect(status).toBe(502);
  });

  it("teks hulu (nama provider, URL) tidak ikut terkirim", async () => {
    const { text } = await runCombo({
      "a/opencode-free": bareResponse(UPSTREAM_403, { status: 403 }),
      "b/opencode-free": bareResponse(UPSTREAM_403, { status: 403 }),
    });
    expect(text.toLowerCase()).not.toContain("opencode");
    expect(text).not.toContain("http");
    expect(text).not.toContain("FreeTierError");
    // The replacement still says something usable: how many ran, what the last
    // status was. A blank body was the K142 defect.
    expect(text).toContain("2/2");
  });

  it("429 tetap 429 — yang itu memang soal laju pemanggil", async () => {
    const { status } = await runCombo({
      "a/slow": bareResponse(JSON.stringify({ error: { message: "rate limit" } }), { status: 429 }),
      "b/slow": bareResponse(JSON.stringify({ error: { message: "rate limit" } }), { status: 429 }),
    });
    expect(status).toBe(429);
  });

  it("label buatan sendiri tetap dikirim apa adanya (tidak disamarkan)", async () => {
    // `empty-refusal (…)` adalah kalimat kita, bukan badan hulu. Menyamarkannya
    // menghapus satu-satunya keterangan yang bisa dibaca operator dari sisi klien.
    const { status, text } = await runCombo({
      "a/x": bareResponse(JSON.stringify({ error: { message: "empty-refusal (NOLAK)" } }), { status: 502 }),
      "b/x": bareResponse(JSON.stringify({ error: { message: "empty-refusal (NOLAK)" } }), { status: 502 }),
    });
    expect(status).toBe(502);
    expect(text).toContain("empty-refusal");
  });
});
