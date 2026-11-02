import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { DeepSeekWebExecutor } from "../../open-sse/executors/deepseek-web.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import { validateToolArguments } from "../../open-sse/translator/deepseekWebToolBinding.js";

const entry = REGISTRY.find((e) => e.id === "deepseek-web");

describe("deepseek-web provider", () => {
  it("is registered as a cookie-authenticated web provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("webCookie");
    expect(entry.authType).toBe("cookie");
    expect(entry.aliases).toContain("ds-web");
    expect(entry.models.length).toBeGreaterThan(0);
  });

  it("builds a runtime PROVIDERS entry on the web completion endpoint", () => {
    expect(PROVIDERS["deepseek-web"]).toBeDefined();
    expect(PROVIDERS["deepseek-web"].baseUrl).toBe(
      "https://chat.deepseek.com/api/v0/chat/completion",
    );
  });

  it("routes to the dedicated executor (and its ds-web alias)", () => {
    expect(hasSpecializedExecutor("deepseek-web")).toBe(true);
    expect(getExecutor("deepseek-web")).toBeInstanceOf(DeepSeekWebExecutor);
    expect(getExecutor("ds-web")).toBeInstanceOf(DeepSeekWebExecutor);
  });

  it("schema-validates bound tool arguments", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" }, days: { type: "integer", minimum: 1 } },
            required: ["city"],
            additionalProperties: false,
          },
        },
      },
    ];

    expect(validateToolArguments(tools, "get_weather", { city: "Berlin" })).toBe(true);
    expect(validateToolArguments(tools, "get_weather", { city: "Berlin", days: 3 })).toBe(true);
    expect(validateToolArguments(tools, "get_weather", { city: 42 })).toBe(false);
    expect(validateToolArguments(tools, "get_weather", { days: 3 })).toBe(false);
    expect(validateToolArguments(tools, "get_weather", { city: "Berlin", extra: true })).toBe(false);
    expect(validateToolArguments(tools, "get_weather", { city: "Berlin", days: 0 })).toBe(false);
    expect(validateToolArguments(tools, "unknown_tool", {})).toBe(false);
  });
});