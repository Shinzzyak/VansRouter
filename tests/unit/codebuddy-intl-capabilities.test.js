import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("CodeBuddy international registry parity", () => {
  it("keeps the transports aligned even though the catalogs differ", () => {
    const cn = REGISTRY.find((entry) => entry.id === "codebuddy-cn");
    const intl = REGISTRY.find((entry) => entry.id === "codebuddy-intl");

    expect(intl).toBeDefined();
    expect(intl.transport.thinkingFormat).toBe(cn.transport.thinkingFormat);
    expect(intl.transport.forceStream).toBe(cn.transport.forceStream);
  });

  // The two gateways are NOT mirrors. Probing /v2/chat/completions per id on
  // 2026-09-11 showed intl refuses most older GLM/MiniMax/DeepSeek ids and CN
  // refuses every GPT id. Asserting a shared catalog hid real per-region
  // coverage, so each list is pinned explicitly. When the gateway adds a model,
  // probe it first, then extend the list here and in capabilities.js together.
  it("pins the live-verified CN catalog", () => {
    const cn = REGISTRY.find((entry) => entry.id === "codebuddy-cn");
    expect(cn.models.map(({ id }) => id)).toEqual([
      "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5.0-turbo",
      "glm-5v-turbo", "minimax-m3", "minimax-m3-pay", "minimax-m2.7",
      "kimi-k3", "kimi-k3-1", "kimi-k2.7", "kimi-k2.6", "kimi-k2.5",
      "hy4-preview", "hy4-preview-f", "hy3", "hy3-x", "hy3-preview",
      "hy3-preview-agent", "deepseek-v4-pro", "deepseek-v4-flash",
      "deepseek-v4.1-flash", "deepseek-v3-2-volc",
    ]);
  });

  it("pins the live-verified intl catalog", () => {
    const intl = REGISTRY.find((entry) => entry.id === "codebuddy-intl");
    expect(intl.models.map(({ id }) => id)).toEqual([
      "glm-5.3", "glm-5.2", "glm-5.1", "glm-5.0", "glm-5v-turbo",
      "minimax-m3", "kimi-k3", "kimi-k2.7", "kimi-k2.6", "kimi-k2.5",
      "hy4-preview", "hy4-preview-x", "hy4-preview-f", "hy3",
      "deepseek-v4.1-flash",
      "gpt-6-astra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex",
    ]);
  });

  it("resolves usage capability parity for every CodeBuddy model", () => {
    const intl = REGISTRY.find((entry) => entry.id === "codebuddy-intl");
    for (const { id } of intl.models) {
      const capabilities = getCapabilitiesForModel("codebuddy-intl", id);
      expect(capabilities.reasoning, id).toBe(true);
      expect(capabilities.thinkingFormat, id).toBeDefined();
    }
  });

  it("resolves authoritative context/output windows for every codebuddy-cn model", () => {
    const cn = REGISTRY.find((entry) => entry.id === "codebuddy-cn");
    for (const { id } of cn.models) {
      const capabilities = getCapabilitiesForModel("codebuddy-cn", id);
      expect(capabilities.reasoning, id).toBe(true);
      expect(capabilities.thinkingFormat, id).toBe("openai");
      expect(capabilities.contextWindow, id).toBeGreaterThan(0);
      expect(capabilities.maxOutput, id).toBeGreaterThan(0);
    }
  });
});
