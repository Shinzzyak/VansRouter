import { test, expect } from "vitest";
import registry from "../../open-sse/providers/registry/qwen.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { getExecutor } from "../../open-sse/executors/index.js";

test("qwen registry: hidden oauth provider with 4 models", () => {
  expect(registry.id).toBe("qwen");
  expect(registry.hidden).toBe(true);
  expect(registry.oauth?.clientId).toBeTruthy();
  expect(registry.oauth?.deviceCodeUrl).toContain("chat.qwen.ai");
  expect(registry.models).toHaveLength(4);
  expect(registry.models.map((m) => m.id)).toContain("qwen3-coder-plus");
});

test("qwen provider registered in PROVIDERS", () => {
  const p = PROVIDERS["qwen"];
  expect(p).toBeTruthy();
  // buildTransport flattens transport into top-level fields
  expect(p.baseUrl).toContain("portal.qwen.ai");
  expect(p.format).toBe("openai");
});

test("qwen executor resolves (non-default)", async () => {
  const executor = getExecutor("qwen");
  expect(executor).toBeTruthy();
  // Qwen uses custom executor with fingerprint headers, not the generic DefaultExecutor
  expect(executor.constructor.name).not.toBe("DefaultExecutor");
});
