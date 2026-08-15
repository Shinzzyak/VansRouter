import { describe, expect, it } from "vitest";
import antigravity from "../../open-sse/providers/registry/antigravity.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("Antigravity Gemini 3.7 catalog", () => {
  it("exposes the plain model and all three tiers", () => {
    expect(antigravity.models.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "gemini-3.7-flash",
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-medium",
      "gemini-3.7-flash-low",
    ]));
  });

  it("resolves upstream capability contract", () => {
    expect(getCapabilitiesForModel("antigravity", "gemini-3.7-flash")).toMatchObject({
      vision: true,
      audioInput: true,
      videoInput: true,
      reasoning: true,
      search: true,
      thinkingFormat: "gemini-level",
      contextWindow: 1048576,
      maxOutput: 65536,
    });
  });
});
