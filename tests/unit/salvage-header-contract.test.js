import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The salvage handshake crosses two files that never import each other:
// nonStreamingHandler raises `x-vansrouter-salvaged`, chatCore reads it to decide
// whether one forced-SSE retry is worth the tokens. Rename one side and the
// retry silently stops happening — the answer still ships (salvaged text), so no
// test would go red on behaviour alone. This pins the wire between them.
const HANDLER = resolve(__dirname, "../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const CORE = resolve(__dirname, "../../open-sse/handlers/chatCore.js");

const HEADER = "x-vansrouter-salvaged";

describe("salvage header contract", () => {
  it("the handler emits the header the core reads", () => {
    const producer = readFileSync(HANDLER, "utf8");
    const consumer = readFileSync(CORE, "utf8");
    expect(producer).toContain(`"${HEADER}"`);
    expect(consumer).toContain(`get?.("${HEADER}")`);
  });

  it("the private _salvaged marker is stripped before serialisation", () => {
    const producer = readFileSync(HANDLER, "utf8");
    expect(producer).toMatch(/delete\s+wireBody\._salvaged/);
  });
});
