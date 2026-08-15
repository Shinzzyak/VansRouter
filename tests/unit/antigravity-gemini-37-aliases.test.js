import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_MODEL_ALIASES } from "../../open-sse/config/antigravityModelAliases.js";
import { MITM_TOOLS } from "../../src/shared/constants/cliTools.js";

describe("Antigravity Gemini 3.7 aliases", () => {
  it("maps the plain model to the established medium tier", () => {
    expect(ANTIGRAVITY_MODEL_ALIASES["gemini-3.7-flash"]).toBe("gemini-3.7-flash-medium");
  });

  it("exposes plain and tiered models to the MITM tool", () => {
    const ids = new Set(MITM_TOOLS.antigravity.modelAliases);
    expect([...ids]).toEqual(expect.arrayContaining([
      "gemini-3.7-flash",
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-medium",
      "gemini-3.7-flash-low",
    ]));
    expect(MITM_TOOLS.antigravity.defaultModels.map((model) => model.id))
      .toEqual(expect.arrayContaining(["gemini-3.7-flash", "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low"]));
  });
});
