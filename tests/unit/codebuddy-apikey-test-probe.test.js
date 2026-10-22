/**
 * The connection-test path must not read a CodeBuddy business code as a bad key.
 *
 * Two defects are locked here:
 *  1. `conversationHeaders()` is the gate fingerprint — if a header name drifts,
 *     every CodeBuddy request drops back to 11128. The test asserts the exact set.
 *  2. The apiKey probe used to hit `deriveValidateUrl()` (/v2/models), which the
 *     gateway answers 404 — so a serving key was reported "Invalid API key".
 *     The validator now sends the chat probe with these same headers.
 *
 * Text assertions on testUtils.js are deliberate: it is a Next server module and
 * importing it drags in next/server + sqlite. The behaviour of the header set is
 * covered for real by importing the executor below.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { conversationHeaders } from "open-sse/executors/codebuddy-intl.js";

const src = fs.readFileSync(
  path.resolve(__dirname, "../../src/app/api/providers/[id]/test/testUtils.js"),
  "utf-8"
);

describe("conversationHeaders() — channel-gate fingerprint", () => {
  it("emits exactly the seven attribution headers", () => {
    const h = conversationHeaders();
    expect(Object.keys(h).sort()).toEqual([
      "X-Agent-Intent",
      "X-Agent-Purpose",
      "X-Agent-Type",
      "X-Conversation-ID",
      "X-Conversation-Message-ID",
      "X-Conversation-Request-ID",
      "X-Request-ID",
    ]);
  });

  it("uses fresh 32-hex ids per call", () => {
    const a = conversationHeaders();
    const b = conversationHeaders();
    for (const k of ["X-Conversation-ID", "X-Conversation-Request-ID", "X-Request-ID"]) {
      expect(a[k]).toMatch(/^[0-9a-f]{32}$/);
      expect(a[k]).not.toBe(b[k]);
    }
  });
});

describe("apiKey connection test — CodeBuddy classification", () => {
  it("has a dedicated case for both hosts before the generic default", () => {
    const caseIdx = src.indexOf('case "codebuddy-intl":');
    const defaultIdx = src.indexOf("default: {\n        // Generic probe using validateUrl");
    expect(caseIdx).toBeGreaterThan(-1);
    expect(defaultIdx).toBeGreaterThan(caseIdx);
    expect(src).toContain('case "codebuddy-cn":');
  });

  it("imports the executor's header builder instead of duplicating it", () => {
    expect(src).toContain('import { conversationHeaders } from "open-sse/executors/codebuddy-intl.js"');
  });

  it("treats 11128 as credential-accepted and 11140 as account-restricted", () => {
    const block = src.slice(src.indexOf('case "codebuddy-intl":'), src.indexOf("default: {", src.indexOf('case "codebuddy-intl":')));
    expect(block).toMatch(/code === 11128[\s\S]{0,220}valid: true/);
    expect(block).toMatch(/code === 11140[\s\S]{0,260}valid: false/);
  });

  it("no longer classifies on bare res.ok for this provider", () => {
    const block = src.slice(src.indexOf('case "codebuddy-intl":'), src.indexOf("default: {", src.indexOf('case "codebuddy-intl":')));
    expect(block).not.toContain('error: "Invalid API key"');
    expect(block).not.toContain("valid: res.ok");
  });
});
