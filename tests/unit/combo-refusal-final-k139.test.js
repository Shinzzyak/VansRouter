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
