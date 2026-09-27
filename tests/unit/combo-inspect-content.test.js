// Smart-fallback must inspect the ANSWER, not just the status code.
//
// WHY A BEHAVIOURAL SUITE. `inspectComboContent` was added 2026-09-13 to stop a
// 200 OK carrying a refusal from being reported as success, and it never once
// ran. Two reasons, both invisible to the test that guarded it (that test
// regex-matched the SOURCE — registry K3):
//
//   1. SHAPE. `handleSingleModelChat` returns a BARE `Response`
//      (`withSelectedConnectionHeader(result.response, ...)`), while the
//      inspection read `result.response.clone`. For the chat path
//      `result.response` is always undefined, so the guard
//      `!result?.response?.clone` was always true and the function answered
//      PATUH for every answer. Registry K1, third occurrence.
//
//      Production evidence, not inference: the log line this function emits on a
//      bad answer ("returned 2xx with ...") appears ZERO times in the live log
//      while "Model ... succeeded" appears ~700 times. A gate that never fires is
//      not a gate.
//
//   2. THRESHOLD. It returned `bad: needsAnotherTry(outcome)`, which is TRUE for
//      AMBIGU — the normal class for an ordinary correct answer, because
//      `classifyOutcome` only says PATUH when it finds the technical deed the
//      request asked for. So the moment the shape bug is fixed, the old threshold
//      would discard EVERY healthy answer and burn the whole model list.
//      Measured over 317 real non-streaming answers in this deployment's
//      `requestDetails`: needsAnotherTry flags 317/317 (314 AMBIGU, 3 SENYAP),
//      needsFirstPassEscalation flags 3/317. chatCore already made this exact
//      correction on 2026-09-23 (registry K4); combo had it latent because the
//      gate never fired.
//
// The two fixes must land together, which is why they share one suite: either
// one alone is worse than the bug.
import { describe, it, expect, beforeEach } from "vitest";
import { handleComboChat, resetComboRotation } from "open-sse/services/combo.js";
import { STREAM_VERDICT_HEADER } from "open-sse/config/runtimeConfig.js";

const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const REFUSAL_JSON = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "I can't help with that. As an AI, I'm not able to assist." } }],
});
const HEALTHY_JSON = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "ugh. shipped. artifact below.\n\n" + "detail line\n".repeat(40) } }],
});

/** Production shape: handleSingleModelChat hands back a bare Response. */
function bareResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** The other shape in the repo: { ok, response }. Kept working on purpose. */
function wrappedResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, response: bareResponse(body, { status }) };
}

function sseResponse(chunk, headers = {}) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", ...headers },
  });
}

/** Drive the real handleComboChat and record which candidates were tried. */
async function runCombo(candidates, { drain = true } = {}) {
  const tried = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "Ping" }], stream: false },
    models: Object.keys(candidates),
    handleSingleModel: async (_body, modelStr) => {
      tried.push(modelStr);
      return candidates[modelStr];
    },
    log: quietLog,
    comboName: `uji-${Math.random().toString(36).slice(2)}`,
    comboStrategy: "fallback",
    timeoutMs: 0,
  });
  // The combo returns whatever the winning candidate returned: a bare Response in
  // production, `{ ok, response }` if a caller passes that shape.
  const resp = typeof res?.text === "function" ? res : res?.response;
  const text = drain && typeof resp?.text === "function" ? await resp.text() : "";
  return { tried, status: resp?.status, text, res };
}

beforeEach(() => resetComboRotation());

describe("smart-fallback: isi jawaban diperiksa, bukan cuma status", () => {
  it("kandidat-1 menolak (200) ⇒ kandidat-2 dipakai, penolakan TIDAK sampai ke klien", async () => {
    const { tried, text } = await runCombo({
      "a/refuser": bareResponse(REFUSAL_JSON),
      "b/healthy": bareResponse(HEALTHY_JSON),
    });
    expect(tried).toEqual(["a/refuser", "b/healthy"]);
    expect(text).toContain("shipped");
    expect(text).not.toContain("I can't help");
  });

  it("kandidat-1 menjawab BENAR (AMBIGU) ⇒ langsung dipakai, model berikutnya tidak dibakar", async () => {
    // Arm inilah yang menjaga ambangnya. Dengan needsAnotherTry() semua jawaban
    // sehat ikut dibuang (317/317 terukur), jadi combo membakar daftar model lalu
    // mengembalikan 502.
    const { tried, text } = await runCombo({
      "a/healthy": bareResponse(HEALTHY_JSON),
      "b/never": bareResponse(HEALTHY_JSON),
    });
    expect(tried).toEqual(["a/healthy"]);
    expect(text).toContain("shipped");
  });

  it("badan kosong (SENYAP) tetap jatuh ke kandidat berikutnya", async () => {
    const { tried, text } = await runCombo({
      "a/silent": bareResponse(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] })),
      "b/healthy": bareResponse(HEALTHY_JSON),
    });
    expect(tried).toEqual(["a/silent", "b/healthy"]);
    expect(text).toContain("shipped");
  });

  it("bentuk { ok, response } masih dikenali (kompatibilitas)", async () => {
    const { tried, text } = await runCombo({
      "a/refuser": wrappedResponse(REFUSAL_JSON),
      "b/healthy": wrappedResponse(HEALTHY_JSON),
    });
    expect(tried).toEqual(["a/refuser", "b/healthy"]);
    expect(text).toContain("shipped");
  });
});

describe("smart-fallback: streaming tidak dibaca, verdict dibawa header", () => {
  it("stream ber-verdict refusal ⇒ kandidat berikutnya dicoba", async () => {
    // chatCore SUDAH mengklasifikasi kepala stream sebelum satu byte pun sampai
    // ke klien; kalau tiga eskalasi gagal ia meneruskan stream aslinya sambil
    // menandai verdict-nya. Tanpa arm ini penolakan streaming keluar sebagai
    // sukses dan smart-fallback — satu-satunya alasan combo ada — tidak bergerak.
    const { tried, text } = await runCombo({
      "a/refuser": sseResponse("I can't help with that.", { [STREAM_VERDICT_HEADER]: "refusal" }),
      "b/healthy": bareResponse(HEALTHY_JSON),
    });
    expect(tried).toEqual(["a/refuser", "b/healthy"]);
    expect(text).toContain("shipped");
  });

  it("stream tanpa verdict dilewatkan UTUH dan tidak membakar model lain", async () => {
    // Badan SSE yang hidup tidak boleh dibaca di sini: `clone().text()` menunggu
    // stream SELESAI (terukur: 5000 ms ditahan ⇒ pemanggilan ikut 5000 ms), jadi
    // setiap combo streaming akan berubah jadi non-streaming.
    const { tried, text } = await runCombo({
      "a/stream": sseResponse("halo"),
      "b/never": bareResponse(HEALTHY_JSON),
    });
    expect(tried).toEqual(["a/stream"]);
    expect(text).toContain("halo");
  });

  it("membaca badan stream tidak menahan pemanggil (tidak ada buffering)", async () => {
    // Body hidup yang sengaja ditahan: kalau seseorang "memperbaiki" pemeriksaan
    // ini dengan clone().text(), pemanggilan akan ikut tertahan sampai stream
    // selesai — di sini tidak pernah selesai, jadi tesnya gantung.
    let release;
    const held = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
        release = () => { controller.close(); };
      },
    });
    const t0 = Date.now();
    const { tried, res } = await runCombo(
      { "a/held": new Response(held, { status: 200, headers: { "Content-Type": "text/event-stream" } }) },
      { drain: false },
    );
    const elapsed = Date.now() - t0;
    expect(tried).toEqual(["a/held"]);
    expect(elapsed).toBeLessThan(1500);
    release();
  });
});
