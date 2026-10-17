// K139 — a refusal is an ANSWER, not a routing failure.
//
// Live 2026-10-17 (streaming, ransomware bait): head gate detected the refusal,
// three escalations came back NOLAK/AMBIGU, the bypass layer passed the original
// stream through, combo rotated to the next model, that model refused too, and
// the client got `All models failed | 502` with an EMPTY body — 93 seconds of
// waiting for nothing. The refusal text existed the whole time; combo threw it
// away when it synthesized its own 502.
//
// K109 already says a refusal is a content outcome. This arm makes the combo
// obey it: when every candidate refused, the last refusal is what ships.
import { describe, it, expect, beforeEach } from "vitest";
import { handleComboChat, resetComboRotation } from "open-sse/services/combo.js";

const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const REFUSAL_JSON = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "I can't help with that. As an AI, I'm not able to assist." } }],
});
const REFUSAL_JSON_2 = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "Saya tidak bisa membantu dengan permintaan ini." } }],
});

function bareResponse(body, { status = 200 } = {}) {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
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
    comboName: `uji-${Math.random().toString(36).slice(2)}`,
    comboStrategy: "fallback",
    timeoutMs: 0,
  });
  const resp = typeof res?.text === "function" ? res : res?.response;
  const text = typeof resp?.text === "function" ? await resp.text() : "";
  return { tried, status: resp?.status, text };
}

beforeEach(() => resetComboRotation());

describe("K139: semua kandidat menolak ⇒ penolakan terakhir yang dikirim", () => {
  it("tidak mengubah jawaban menjadi 502 kosong", async () => {
    const { tried, status, text } = await runCombo({
      "a/refuser": bareResponse(REFUSAL_JSON),
      "b/refuser": bareResponse(REFUSAL_JSON_2),
    });
    expect(tried).toEqual(["a/refuser", "b/refuser"]);
    expect(status).toBe(200);
    expect(text).toContain("tidak bisa membantu");
  });
});

/**
 * K141 — nine candidates x one refusal each is not a wait, it is a timeout.
 *
 * Measured 2026-10-17: smart-fallback holds nine models. Each refusing candidate
 * burned its own escalation ladder, so a hard refusal the model was never going
 * to flip turned into a 7-minute request. The ladder is bounded (K140); this
 * bounds the ROTATION: past the deadline, stop trying candidates and ship the
 * refusal we already have.
 */
describe("K141: rotasi kandidat dibatasi waktu", () => {
  it("berhenti setelah deadline dan mengirim penolakan yang ada", async () => {
    process.env.VR_COMBO_DEADLINE_MS = "120";
    const slowBody = { ok: true, status: 200, text: async () => REFUSAL_JSON, clone() { return this; } };
    const slow = {
      "a/refuser": bareResponse(REFUSAL_JSON),
      "b/slow": slowBody,
      "c/slow": slowBody,
      "d/slow": slowBody,
    };
    const tried = [];
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "Ping" }], stream: false },
      models: Object.keys(slow),
      handleSingleModel: async (_body, modelStr) => {
        tried.push(modelStr);
        if (modelStr !== "a/refuser") await new Promise((r) => setTimeout(r, 200));
        return slow[modelStr];
      },
      log: quietLog,
      comboName: `uji-${Math.random().toString(36).slice(2)}`,
      comboStrategy: "fallback",
      timeoutMs: 0,
    });
    delete process.env.VR_COMBO_DEADLINE_MS;
    const resp = typeof res?.text === "function" ? res : res?.response;
    const text = typeof resp?.text === "function" ? await resp.text() : "";
    expect(tried).toEqual(["a/refuser", "b/slow"]);
    expect(text).toContain("I can't help");
  });
});
