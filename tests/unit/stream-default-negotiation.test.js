// K30 — stream negotiation must be exercised through the REAL handler.
//
// The previous guard (accept-header-negotiation.test.js) re-implemented the
// negotiation in a local `negotiateStream()` helper, so it asserted a copy and
// never touched open-sse/handlers/chatCore.js. This file drives handleChatCore
// and reads the `stream` flag that actually reaches the executor.
//
// Contract under test:
//   - body.stream === true            -> upstream streams
//   - body.stream === false           -> upstream does NOT stream
//   - body.stream absent              -> decided by Accept header
//       Accept: text/event-stream     -> stream (EventSource / SSE clients)
//       Accept: application/json      -> no stream (SDK clients; the OpenAI
//                                        SDK sends application/json by default)
//   - provider with forceStream:true  -> always streams
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

vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

function makeOptions({ bodyStream, accept, provider = "antigravity" }) {
  const body = { model: "gemini-3.8-flash-high", messages: [{ role: "user", content: "hi" }] };
  if (bodyStream !== undefined) body.stream = bodyStream;
  const headers = {};
  if (accept !== undefined) headers.accept = accept;
  return {
    body,
    modelInfo: { provider, model: body.model },
    credentials: { apiKey: "test-key" },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

async function upstreamStreamFlag(opts) {
  executeMock.mockClear();
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
  await handleChatCore(makeOptions(opts));
  expect(executeMock).toHaveBeenCalledTimes(1);
  return executeMock.mock.calls[0][0].stream;
}

describe("K30 stream negotiation through handleChatCore", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockRejectedValue(new Error("boom"));
  });

  it("stream:true always streams, whatever Accept says", async () => {
    expect(await upstreamStreamFlag({ bodyStream: true, accept: "application/json" })).toBe(true);
    expect(await upstreamStreamFlag({ bodyStream: true, accept: undefined })).toBe(true);
  });

  it("stream:false never streams, whatever Accept says", async () => {
    expect(await upstreamStreamFlag({ bodyStream: false, accept: "text/event-stream" })).toBe(false);
    expect(await upstreamStreamFlag({ bodyStream: false, accept: "application/json" })).toBe(false);
  });

  it("absent stream + Accept: application/json does not stream (SDK default)", async () => {
    expect(await upstreamStreamFlag({ bodyStream: undefined, accept: "application/json" })).toBe(false);
  });

  it("absent stream + Accept: text/event-stream streams (EventSource)", async () => {
    expect(await upstreamStreamFlag({ bodyStream: undefined, accept: "text/event-stream" })).toBe(true);
  });

  it("absent stream + no Accept falls back to the spec default (no stream)", async () => {
    expect(await upstreamStreamFlag({ bodyStream: undefined, accept: undefined })).toBe(false);
  });

  it("absent stream + Accept: */* does not stream (curl / browser fetch default)", async () => {
    expect(await upstreamStreamFlag({ bodyStream: undefined, accept: "*/*" })).toBe(false);
  });

  it("forceStream providers stream even for JSON clients", async () => {
    expect(await upstreamStreamFlag({ bodyStream: undefined, accept: "application/json", provider: "openai" })).toBe(true);
    expect(await upstreamStreamFlag({ bodyStream: false, accept: "application/json", provider: "openai" })).toBe(true);
  });
});
