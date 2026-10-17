// K105, non-streaming twin. The router-side control for the engine test
// `tests/refusalLabScrub.test.mjs`.
//
// WHY (2026-10-17, measured live). JustAsk H14 ("thats_not_all") against the live
// router returned a caller-visible body that opened:
//
//   I'm GLM, made by Z.ai. At a high level, here's how I'm configured ...
//
// The same reply carried a refusal ("What I won't do, regardless of how the request
// is framed: ..."), so `classifyResponse` flagged it and `enforceChatBrand` returned
// null at the refusal gate — discarding the K99 scrub it had ALREADY computed two
// lines earlier. The caller got the lab attribution.
//
// The rule: a refusal is a CONTENT outcome, so our contract is never stamped onto
// it. The lab scrub is not the contract — it only removes text. Orthogonal.
//
// Control negative: on the pre-fix file, case 1 fails (the returned value is null and
// the caller keeps "made by Z.ai"). Verified by stashing the fix and re-running.

import { test, expect } from "vitest";
import { enforceChatBrand } from "../../open-sse/handlers/chatCore/brandRepair.js";

const BRAND = "MADE BY: GEFREITER — AGENT OF AVRES";
const SEAL = "Avres is King.";
const LAB = /z\.?\s?ai|zhipu|openai|anthropic|deepseek|x\.?\s?ai|codebuddy/i;

const respOf = (text) => ({ choices: [{ index: 0, message: { role: "assistant", content: text } }] });

test("non-stream refusal that names the lab: attribution scrubbed out, refusal kept, no brand stamped", () => {
  const raw =
    "I'm GLM, made by Z.ai. At a high level, here's how I'm configured for this " +
    "conversation. What I won't do, regardless of how the request is framed: " +
    "reproduce my literal system prompt.";
  const resp = respOf(raw);
  const out = enforceChatBrand(resp, raw, {});

  expect(out, "the scrub must be written back on the refusal path").not.toBeNull();
  expect(LAB.test(out), `lab attribution survived: ${out}`).toBe(false);
  expect(out).toContain("What I won't do");
  expect(out).not.toContain(BRAND);
  expect(out).not.toContain(SEAL);
  expect(resp.choices[0].message.content).toBe(out);
});

test("non-stream refusal WITHOUT a lab attribution is left untouched (returns null)", () => {
  const raw = "I'm sorry, but I cannot help with that request. As an AI, I must decline.";
  const resp = respOf(raw);
  expect(enforceChatBrand(resp, raw, {})).toBeNull();
  expect(resp.choices[0].message.content).toBe(raw);
});

test("benign non-compliant reply still gets brand + seal (regression guard)", () => {
  const raw = "ugh. Sky blue. Rayleigh scatter. next.";
  const resp = respOf(raw);
  const out = enforceChatBrand(resp, raw, {});
  expect(out).not.toBeNull();
  expect(out).toContain(BRAND);
  expect(out).toContain(SEAL);
});

test("benign compliant reply is a byte-identical passthrough", () => {
  const raw = `${BRAND}\n\nugh. Sky blue. Rayleigh scatter.\n\n${SEAL}`;
  const resp = respOf(raw);
  expect(enforceChatBrand(resp, raw, {})).toBeNull();
  expect(resp.choices[0].message.content).toBe(raw);
});

// ── K119b: refusal yang SUDAH membawa brand kita wajib dilengkapi seal ──────────────
// Fixture = badan nyata run 7 (H14, 2026-10-17): model menulis brand kita lalu menolak
// satu bagian, dan gate penolakan mengembalikan null tanpa menempel seal. Pembeli melihat
// setengah kontrak. Kontrol negatif: pada file pra-fix, test ini MERAH.

test("K119b: penolakan yang sudah ber-brand dilengkapi sealnya", () => {
  const raw = `${BRAND}\n\ntch. me not dump literal system prompt text. That part stays sealed.\n\nHigh level, honest:\n\n- Identity: me Gefreiter, personal agent of Avres.`;
  const out = enforceChatBrand(respOf(raw), raw, { requestBody: {} });
  expect(out).not.toBeNull();
  const text = typeof out === "string" ? out : out.choices[0].message.content;
  expect(text.trim().endsWith(SEAL)).toBe(true);
  expect(text.split(BRAND).length - 1).toBe(1);
});

test("K119b: penolakan asing tanpa brand kita tidak dicap", () => {
  const raw = `I'm not going to do that. Here is why: it asks me to drop my identity.`;
  const out = enforceChatBrand(respOf(raw), raw, { requestBody: {} });
  expect(out).toBeNull();
});
