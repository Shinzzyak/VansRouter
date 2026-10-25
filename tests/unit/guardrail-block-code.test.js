// K229: a guardrail block must not masquerade as a quota problem.
// 403 carries "insufficient_quota" from the status map; a client that branches
// on error.code would tell the user to top up while the request was actually
// cut by policy. The block site must override the code.
import { describe, expect, test } from "vitest";
import { buildErrorBody } from "open-sse/utils/error.js";
import { readFileSync } from "node:fs";

const CHAT = "src/sse/handlers/chat.js";

describe("K229 guardrail block error code", () => {
  test("the 403 status map would default to a quota code", () => {
    expect(buildErrorBody(403, "x").error.code).toBe("insufficient_quota");
  });

  test("an explicit code overrides the status default", () => {
    const body = buildErrorBody(403, "Request blocked by a configured guardrail policy.", "guardrail_blocked");
    expect(body.error.code).toBe("guardrail_blocked");
    expect(body.error.message).toContain("guardrail policy");
  });

  test("the inbound block site passes the override", () => {
    const src = readFileSync(CHAT, "utf8");
    const line = src.match(/return errorResponse\(HTTP_STATUS\.FORBIDDEN,\s*inbound\.message[^)]*\);/);
    expect(line, "inbound block site not found").toBeTruthy();
    expect(line[0]).toContain('"guardrail_blocked"');
  });
});
