import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("CodeBuddy international registry parity", () => {
  it("matches CodeBuddy CN model coverage and transport capability", () => {
    const cn = REGISTRY.find((entry) => entry.id === "codebuddy-cn");
    const intl = REGISTRY.find((entry) => entry.id === "codebuddy-intl");

    expect(intl).toBeDefined();
    expect(intl.models.map(({ id }) => id)).toEqual(cn.models.map(({ id }) => id));
    expect(intl.transport.thinkingFormat).toBe(cn.transport.thinkingFormat);
    expect(intl.transport.forceStream).toBe(cn.transport.forceStream);
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
