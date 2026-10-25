import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../open-sse/handlers/chatCore.js", import.meta.url), "utf8");

describe("K231 — refusal attribution flip carries evidence and never rewrites history", () => {
  it("the non-streaming ladder quotes the refusal it is reacting to", () => {
    expect(SRC).toMatch(/buildForeignRefusalEscalation\(responseText\)/);
  });

  it("the stream-head ladder quotes the offending head", () => {
    expect(SRC).toMatch(/buildForeignRefusalEscalation\(gate\.headText\)/);
  });

  it("escalation only APPENDS to the last user turn — no message is dropped or rewritten", () => {
    const start = SRC.indexOf("const m = [...(translatedBody.messages || [])];");
    expect(start).toBeGreaterThan(-1);
    const block = SRC.slice(start, start + 700);
    expect(block).toMatch(/m\[i\] = \{ \.\.\.m\[i\], content: m\[i\]\.content \+ `\\n\\n\$\{esc\}` \}/);
    expect(block).not.toMatch(/\.splice\(|\.slice\(0,|messages = \[\]/);
  });
});
