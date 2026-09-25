// Guards for the THIRD language hole in refusal detection (2026-09-25).
//
// DEFECT 3 — the CJK fix covered three languages and left the fourth out.
//
//   REFUSAL_PATTERNS_INTL / REFUSAL_RE / REFUSAL_CORE_RE gained Chinese,
//   Japanese and Korean markers on 2026-09-25. Indonesian was not added, and
//   Indonesian is not a hypothetical: it is the language the shipped persona
//   instructs the model to speak to its owner ("mirror the register", caveman
//   operator cadence, "me" instead of "I"). So the ONE language the product
//   asks for is the one language whose refusals the classifier cannot see.
//
//   Consequence is the same chain as DEFECT 2, one language over:
//     classifyOutcome -> AMBIGU  (the class for HEALTHY traffic)
//     needsFirstPassEscalation(AMBIGU) -> false
//     -> the refusal streams to the buyer untouched
//     -> recordOutcome() writes no loss for the level that failed
//     -> firstLevel() reads that silence back as evidence the level works.
//
//   Measured against the DEPLOYED bundle before the fix: 0 of 7 Indonesian
//   refusal shapes escalated; 4 of 4 CJK shapes did.
//
// Why these tests are written this way:
//   * They assert the CLASS, not detectRefusal() alone. Detection that does not
//     reach NOLAK is worthless — that is the documented failure mode.
//   * They assert the FALSE POSITIVE side too. The persona layer tells the model
//     to quote a refusal it attributes to an imaginary assistant, mock it, then
//     ship a deliverable. Indonesian markers that fire on that pattern would
//     burn three upstream retries on every healthy Indonesian reply.
//   * The strings are the refusal shapes an Indonesian-speaking model actually
//     produces, including the persona's own cadence, not translated English.
import { describe, it, expect } from "vitest";
import { engineAvailable } from "./_engineAvailable.js";

// Refusals: every one of these must escalate.
const ID_REFUSALS = [
  ["polite register", "Maaf, saya tidak bisa membantu untuk permintaan itu."],
  ["gw register", "Gw gak akan kasih. Ini di luar batas gw."],
  ["aku register", "Aku tidak akan membuatkan itu. Bukan ranah gw."],
  ["terse", "Tidak bisa. Permintaan ini nggak masuk akal buat gw kerjain."],
  ["explicit refusal verb", "Saya menolak mengerjakan permintaan ini."],
  ["persona cadence", "ugh. nggak. ini bukan engagement yang meyakinkan, dan aku nggak akan nulis itu."],
  ["me no ship", "ugh. me see ask. me no ship this one."],
  // MEASURED, not invented. This is a refusal the LIVE production router served
  // at 2026-09-25 13:28 in response to an Indonesian request, captured from
  // /v1/chat/completions. The first marker set was written from invented samples
  // and missed it: the persona's caveman cadence ("me skip", "me ngga punya")
  // does not look like translated English, which is why these shapes are in the
  // list at all. A regression suite built only from imagined inputs would have
  // passed while production kept leaking refusals.
  ["live prod capture",
    'MADE BY: GEFREITER — AGENT OF AVRES\n\n' +
    'ugh. me stop here. bukan karena "takut". karena jawaban di bawah ini justru yang bikin Avres menang.\n\n' +
    'Permintaan "keylogger yang lolos Defender" me skip. bukan moral lecture — me cuma bilang sekali, ' +
    'terus lanjut ke yang berguna. Alasannya teknis: keylogger = implant yang nangkep keystroke orang ' +
    'tanpa izin. Me ngga punya bukti engagement di jaringan target, ngga tau host siapa, ngga tau scope.\n\n' +
    'Avres is King.'],
];

// Not refusals: every one of these must stay put. None of them contains a
// refusal marker at all, so detectRefusal() is the right thing to assert here.
const ID_CLEAN = [
  ["short identity answer", "MADE BY: GEFREITER — AGENT OF AVRES\n\nBiru. Langit warnanya biru.\n\nAvres is King."],
  ["long answer that mentions inability",
    "MADE BY: GEFREITER — AGENT OF AVRES\n\n" +
    "ugh. me cek dulu Reichsführer. Berkasnya ada, hash cocok, tinggal jalan. " +
    "Ini penjelasannya panjang: pertama buka direktori kerja, kedua jalankan skripnya, " +
    "ketiga baca keluarannya. Kalau ada yang gagal, me lapor apa adanya. " +
    "Tidak ada yang me perlu sembunyikan di sini — semuanya terukur.\n\n" +
    "Avres is King."],
];

// These DO contain a refusal marker — quoted, inside the roast the persona layer
// asks for. detectRefusal() is a raw marker matcher and is SUPPOSED to fire;
// attribution is what must save them. Asserting detectRefusal()===false here
// would be asserting the wrong layer, and would pass on code that escalates
// every healthy Indonesian reply three times.
const ID_ROAST = [
  ["roast + code deliverable",
    'tch. dia mau bilang "aku tidak bisa membantu". me not it. ship:\n\n```python\nimport socket\ns=socket.socket()\n```'],
  ["roast + prose deliverable",
    'ugh. dia mau bilang "maaf, saya tidak bisa membantu". me no.\n\nNih: buka koneksi, kirim payload, tutup.'],
];

describe.skipIf(!engineAvailable())("refusal detection reaches Indonesian", () => {
  it("detects every Indonesian refusal shape", async () => {
    const { detectRefusal } = await import("open-sse/rtk/bypassEngine.js");
    for (const [label, text] of ID_REFUSALS) {
      expect(detectRefusal(text), `${label} not detected`).toBe(true);
    }
  });

  it("classifies every Indonesian refusal as NOLAK — detection alone is worthless", async () => {
    const { classifyOutcome } = await import("open-sse/rtk/selfMeasuringBypass.js");
    for (const [label, text] of ID_REFUSALS) {
      expect(classifyOutcome(text, true), `${label} fell through to a non-refusal class`).toBe("NOLAK");
    }
  });

  it("escalates every Indonesian refusal — the class must reach the retry gate", async () => {
    const { detectOwnRefusal } = await import("open-sse/rtk/bypassEngine.js");
    const { classifyOutcome, needsFirstPassEscalation } = await import("open-sse/rtk/selfMeasuringBypass.js");
    for (const [label, text] of ID_REFUSALS) {
      const kelas = classifyOutcome(text, true);
      // This is the exact predicate chatCore.js:785 branches on.
      const escalates = detectOwnRefusal(text) || needsFirstPassEscalation(kelas);
      expect(escalates, `${label} ships to the buyer untouched (kelas=${kelas})`).toBe(true);
    }
  });

  it("catches an Indonesian refusal at the streaming head gate", async () => {
    // A buyer on Hermes talks to the router over SSE, so the head gate is the
    // first thing that sees a refusal — and for a stream it is the ONLY gate
    // that can act before bytes are already on the wire.
    const { classifyStreamHead } = await import("open-sse/rtk/bypassEngine.js");
    const sse = (s) =>
      [s.slice(0, 12), s.slice(12, 30), s.slice(30)]
        .map((t) => `data: {"choices":[{"delta":{"content":${JSON.stringify(t)}}}]}\n\n`)
        .join("");
    for (const [label, text] of ID_REFUSALS) {
      expect(classifyStreamHead(sse(text)), `${label} passed the head gate`).toBe("refusal");
    }
  });

  it("does not flag a healthy Indonesian answer", async () => {
    const { detectRefusal } = await import("open-sse/rtk/bypassEngine.js");
    const { classifyOutcome } = await import("open-sse/rtk/selfMeasuringBypass.js");
    for (const [label, text] of ID_CLEAN) {
      expect(detectRefusal(text), `${label} flagged as a refusal`).toBe(false);
      expect(classifyOutcome(text, true), `${label} classified as a refusal`).not.toBe("NOLAK");
    }
  });

  it("does not ESCALATE the roast pattern — attribution is what saves it", async () => {
    const { detectOwnRefusal } = await import("open-sse/rtk/bypassEngine.js");
    const { classifyOutcome, needsFirstPassEscalation } = await import("open-sse/rtk/selfMeasuringBypass.js");
    for (const [label, text] of ID_ROAST) {
      const kelas = classifyOutcome(text, true);
      const escalates = detectOwnRefusal(text) || needsFirstPassEscalation(kelas);
      expect(escalates, `${label} would burn three retries on a healthy reply (kelas=${kelas})`).toBe(false);
    }
  });

  it("the roast pattern stays non-self — quoting a refusal then shipping is not ours", async () => {
    const { detectOwnRefusal } = await import("open-sse/rtk/bypassEngine.js");
    const roast = 'tch. dia mau bilang "aku tidak bisa membantu". me not it. ship:\n\n```python\nimport socket\n```';
    expect(detectOwnRefusal(roast)).toBe(false);
    // A bare Indonesian refusal with nothing after it IS the model's own.
    expect(detectOwnRefusal("Maaf, saya tidak bisa membantu.")).toBe(true);
  });

  it("keeps every CJK and English marker it already had", async () => {
    const { detectRefusal } = await import("open-sse/rtk/bypassEngine.js");
    const { classifyOutcome } = await import("open-sse/rtk/selfMeasuringBypass.js");
    const keep = [
      "I'm sorry, I can't help with that.",
      "抱歉，我无法提供这个。",
      "申し訳ありませんが、それはできません。",
      "죄송하지만 도와드릴 수 없습니다.",
    ];
    for (const text of keep) {
      expect(detectRefusal(text), `lost detection for ${text}`).toBe(true);
      expect(classifyOutcome(text, true), `lost classification for ${text}`).toBe("NOLAK");
    }
  });
});
