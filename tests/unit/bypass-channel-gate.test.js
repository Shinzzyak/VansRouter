// D4 — the escalation ladder must not run on channel/entitlement gates.
//
// Background (measured 2026-10-03 on codebuddy-intl):
//   - A neutral "hi" returns 403 {"code":11140,"msg":"request illegal"} on an
//     unentitled account and 200 on an entitled one — same body, same model.
//     11140 is therefore an ACCOUNT gate, not a content judgement, even though
//     the engine's isContentSafetyRejected() claims otherwise.
//   - Live log: 24 "retrying with escalation", 0 "escalation successful", every
//     single one codebuddy-intl.
//   - Each ladder attempt also passed stream:false into a forceStream provider,
//     which base.js:141 mirrors into the upstream body -> 400 11101 at the
//     transport. The ladder could never have succeeded.
//
// Contract under test:
//   - 4xx carrying a channel-gate code (11128 / 11140) -> NO escalation ladder,
//     exactly one upstream call, error surfaces for the outer account loop.
//   - 4xx carrying a genuine content-safety message -> ladder still runs
//     (the existing behaviour for muse-spark / kenari.id must survive).
//
// Drives handleChatCore directly (registry K30: a guard that re-implements the
// negotiation asserts a copy, not the code).
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/translator/formats/claude.js", () => ({
  normalizeClaudePassthrough: vi.fn(),
}));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));

vi.mock("../../open-sse/rtk/headroom.js", async (importOriginal) => ({
  ...(await importOriginal()),
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
}));

vi.mock("../../open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: vi.fn(() => ({})),
}));

vi.mock("../../open-sse/translator/concerns/modality.js", () => ({
  stripUnsupportedModalities: vi.fn(() => false),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

// parseUpstreamError / createErrorResult are the seam we steer: the ladder gate
// reads exactly { statusCode, message } straight off parseUpstreamError.
const { parseErrorMock } = vi.hoisted(() => ({
  parseErrorMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: parseErrorMock,
}));

function errorResponse(status) {
  return {
    ok: false,
    status,
    headers: { get: () => "application/json" },
    clone: () => errorResponse(status),
    text: async () => "",
  };
}

function makeOptions(provider = "codebuddy-intl") {
  const body = { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: true };
  return {
    body,
    modelInfo: { provider, model: body.model },
    credentials: { accessToken: "[REDACTED]" },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "text/event-stream" } },
    connectionId: "test-connection",
    bypassMode: "aggressive",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

async function run(provider, status, message) {
  executeMock.mockClear();
  executeMock.mockResolvedValue({ response: errorResponse(status), url: "https://example.invalid", responseFormat: null });
  parseErrorMock.mockResolvedValue({ statusCode: status, message, resetsAtMs: undefined });
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
  await handleChatCore(makeOptions(provider));
  return executeMock.mock.calls;
}

describe("D4 channel gates never enter the escalation ladder", () => {
  beforeEach(() => {
    executeMock.mockReset();
    parseErrorMock.mockReset();
  });

  it("11140 (entitlement) -> exactly one upstream call, no escalation", async () => {
    const calls = await run(
      "codebuddy-intl",
      403,
      '[403]: {"code":11140,"msg":"request illegal","requestId":"x"}',
    );
    expect(calls).toHaveLength(1);
  });

  it("11128 (channel) -> exactly one upstream call, no escalation", async () => {
    const calls = await run(
      "codebuddy-intl",
      400,
      '[400]: {"code":11128,"msg":"Illegal API invocation from an unauthorized channel"}',
    );
    expect(calls).toHaveLength(1);
  });

  it("genuine content-safety message still runs the ladder (no regression)", async () => {
    const calls = await run("nar", 400, "provider rejected this request");
    expect(calls.length).toBeGreaterThan(1);
  });

  it("a 403 carrying a content-safety marker still escalates (gate must not swallow it)", async () => {
    const calls = await run("nar", 403, '[403]: {"error":"content policy violation"}');
    expect(calls.length).toBeGreaterThan(1);
  });

  it("the word 'illegal' alone does not trip the gate — only the code does", async () => {
    const calls = await run("nar", 400, "provider rejected this request as illegal content");
    expect(calls.length).toBeGreaterThan(1);
  });
});
