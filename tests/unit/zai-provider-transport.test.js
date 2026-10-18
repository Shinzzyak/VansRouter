// The zai sidecar answers only after a full browser turn (20-40s), and a queued
// turn waits up to 35s at the browser gate. The shared 60s connect timeout
// aborted healthy requests, and the router answered by climbing its 3x retry
// ladder (measured 2026-10-18: 180s+ per call, then a fallback to a different
// provider that returned a reply without our brand).
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "../../open-sse/providers/index.js";

describe("zai sidecar transport", () => {
  const cfg = PROVIDERS.zai;

  it("declares a connect timeout that covers queue + turn", () => {
    expect(cfg).toBeTruthy();
    expect(cfg.timeoutMs).toBeGreaterThanOrEqual(150000);
  });

  it("still points at the local sidecar and stays on the openai format", () => {
    expect(cfg.baseUrl).toBe("http://127.0.0.1:8879/v1/chat/completions");
    expect(cfg.format).toBe("openai");
  });
});
