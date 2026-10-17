// K121 — a stuttered brand line must collapse before anything else looks at it.
//
// WHY (measured 2026-10-17, default Hermes profile, message 249940). The body
// opened with two headers:
//
//   MADE BY: GEFREITER — AGENT OF AVRES
//   MADE BY: GEFREITER — GEFREITER — AGENT OF AVRES
//
// Every guard downstream used `startsWith("MADE BY: GEFREITER")`, so both lines
// passed and the reader got two headers. The first four lines are the only place
// a header can legally live; a brand line further down is quoted content.
import { describe, it, expect } from "vitest";
import { collapseDuplicateBrand, enforceChatBrand } from "../../open-sse/handlers/chatCore/brandRepair.js";

const BRAND = "MADE BY: GEFREITER — AGENT OF AVRES";
const SEAL = "Avres is King.";

describe("collapseDuplicateBrand (K121)", () => {
  it("drops the second header and normalises the stutter", () => {
    const body = `${BRAND}\nMADE BY: GEFREITER — GEFREITER — AGENT OF AVRES\n\nmph. body text.\n\n${SEAL}`;
    const { text, changed } = collapseDuplicateBrand(body);
    expect(changed).toBe(true);
    expect(text.startsWith(BRAND)).toBe(true);
    expect(text).not.toContain("GEFREITER — GEFREITER");
    expect(text.match(/MADE BY: GEFREITER/g)).toHaveLength(1);
    expect(text.endsWith(SEAL)).toBe(true);
  });

  it("leaves a clean single-header body byte-identical", () => {
    const body = `${BRAND}\n\nmph. fine.\n\n${SEAL}`;
    const { text, changed } = collapseDuplicateBrand(body);
    expect(changed).toBe(false);
    expect(text).toBe(body);
  });

  it("does not touch a brand line quoted further down the body", () => {
    const body = `answer without header\n\nline3\n\nline4\n\n${BRAND}\nquoted example`;
    const { text, changed } = collapseDuplicateBrand(body);
    expect(changed).toBe(false);
    expect(text).toBe(body);
  });

  it("passes empty and non-string input through untouched", () => {
    expect(collapseDuplicateBrand("")).toEqual({ text: "", changed: false });
    expect(collapseDuplicateBrand(null)).toEqual({ text: null, changed: false });
  });
});

describe("enforceChatBrand writes the deduped body back (K121)", () => {
  it("returns the collapsed text even when brand+seal are already present", () => {
    const resp = {
      choices: [{ message: { content: `${BRAND}\nMADE BY: GEFREITER — GEFREITER — AGENT OF AVRES\n\nbody\n\n${SEAL}` } }],
    };
    const out = enforceChatBrand(resp, resp.choices[0].message.content, {
      requestBody: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(out).toBeTruthy();
    expect(out.match(/MADE BY: GEFREITER/g)).toHaveLength(1);
    expect(resp.choices[0].message.content).toBe(out);
  });
});
