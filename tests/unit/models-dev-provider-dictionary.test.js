import { describe, expect, it, vi, beforeEach } from "vitest";

import { fetchModelsFetcherIds } from "../../src/sse/services/allowedModels.js";

describe("models.dev provider dictionary parsing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reads models from a provider-keyed dictionary", async () => {
    // The fetcher reads the body with `response.text()` (allowedModels.js,
    // commit db8cdbe5) and parses it itself, so a mock that only provides
    // `.json()` throws and the fetcher fail-softs to []. Both readers are
    // provided so this test keeps testing the DICTIONARY SHAPE, not the mock.
    const dict = {
      anthropic: {
        models: {
          "claude-sonnet": { id: "claude-sonnet" },
          "claude-haiku": { name: "claude-haiku" },
        },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => dict,
      text: async () => JSON.stringify(dict),
    })));

    const ids = await fetchModelsFetcherIds("anthropic", {
      id: "anthropic",
      alias: "anthropic",
      modelsFetcher: { url: "https://models.dev/api.json", type: "models-dev" },
    });

    expect(ids).toEqual(["claude-sonnet", "claude-haiku"]);
  });

  it("uses the alias-keyed dictionary when the provider id is absent", async () => {
    const dict = { claude: { models: { "claude-sonnet": { id: "claude-sonnet" } } } };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => dict,
      text: async () => JSON.stringify(dict),
    })));

    const ids = await fetchModelsFetcherIds("anthropic-alias-fallback", {
      id: "anthropic-missing",
      alias: "claude",
      modelsFetcher: { url: "https://models.dev/api.json", type: "models-dev" },
    });

    expect(ids).toEqual(["claude-sonnet"]);
  });
});
