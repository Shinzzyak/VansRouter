import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { isDegenerateText } from "../../open-sse/rtk/flakyGuard.js";

// K272 — five provider/quality ports absorbed from 9router-pro, JRouter and
// LAM-Router. Each block asserts the thing that made the port worth doing:
// a real endpoint, a non-empty catalog, and a live entry in the runtime maps.
const byId = (id) => REGISTRY.find((e) => e.id === id);

describe("K272 ported providers — registry shape", () => {
  it("keeps every registry id unique", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ["sensenova", "https://token.sensenova.cn/v1/chat/completions"],
    ["runcrate", "https://api.runcrate.ai/v1/chat/completions"],
    ["river", "https://api.river.ai/v1/chat/completions"],
    ["beatapi", "https://api.beatapi.io/v1/chat/completions"],
    ["workbuddy", "https://www.workbuddy.ai/v2/chat/completions"],
  ])("%s is registered with its own endpoint", (id, baseUrl) => {
    const entry = byId(id);
    expect(entry).toBeDefined();
    expect(entry.transport.baseUrl).toBe(baseUrl);
    expect(PROVIDERS[id]).toBeDefined();
    expect(entry.models.length).toBeGreaterThan(0);
  });

  it("seeds the runtime model map for the apikey lanes", () => {
    // OAuth lanes (workbuddy, codebuddy-*) resolve models per account at runtime,
    // so PROVIDER_MODELS is only populated for the apikey entries.
    for (const id of ["sensenova", "runcrate", "river", "beatapi"]) {
      expect((PROVIDER_MODELS[id] || []).length).toBeGreaterThan(0);
    }
  });

  it("marks the four API-key gateways as apikey, workbuddy as oauth-capable", () => {
    for (const id of ["sensenova", "runcrate", "river", "beatapi"]) {
      expect(byId(id).category).toBe("apikey");
    }
    expect(byId("workbuddy").category).toBe("oauth");
    expect(byId("workbuddy").hasOAuth).toBe(true);
  });

  it("points beatapi at the free-id catalog and lets unknown ids pass through", () => {
    const beat = byId("beatapi");
    expect(beat.passthroughModels).toBe(true);
    expect(PROVIDER_MODELS.beatapi.every((m) => m.id.endsWith("-free"))).toBe(true);
  });

  it("keeps sensenova's image lane declared", () => {
    const sn = byId("sensenova");
    expect(sn.imageConfig.baseUrl).toBe("https://token.sensenova.cn/v1/images/generations");
    expect(sn.serviceKinds).toContain("image");
  });

  it("gives workbuddy the plugin OAuth endpoints its refresh path reads", () => {
    const wb = byId("workbuddy");
    expect(wb.oauth.platform).toBe("workbuddy");
    expect(wb.oauth.stateUrl).toBe("https://www.workbuddy.ai/v2/plugin/auth/state");
    expect(wb.oauth.refreshUrl).toBe("https://www.workbuddy.ai/v2/plugin/auth/token/refresh");
  });

  it("registers the workbuddy oauth flow so /api/oauth/workbuddy can start one", async () => {
    const { getProvider } = await import("../../src/lib/oauth/providers.js");
    const flow = getProvider("workbuddy");
    expect(flow).toBeDefined();
    expect(flow.flowType).toBe("device_code");
    expect(typeof flow.requestDeviceCode).toBe("function");
    expect(typeof flow.pollToken).toBe("function");
    expect(flow.config.platform).toBe("workbuddy");
  });
});

describe("K272 flakyGuard — repetition loop detection", () => {
  it("flags an empty answer repeated until it fills the body", () => {
    expect(isDegenerateText("OK. OK. OK. OK. OK. OK. OK. OK.")).toBe(true);
    // A refusal loop is degenerate too — it goes to fallback either way; keeping
    // it here proves the loop rule does not depend on the vocabulary rule.
    expect(isDegenerateText("I'm sorry. ".repeat(6))).toBe(true);
  });

  it("flags one word repeated past 50% of a long answer", () => {
    expect(isDegenerateText("ok ok ok ok ok ok ok ok ok ok ok ok done")).toBe(true);
  });

  it("leaves real answers alone", () => {
    expect(isDegenerateText("Ya, WPA2 masih dipakai di banyak router rumah.")).toBe(false);
    expect(isDegenerateText("Berikut kode:\n```js\nconst a = 1;\nconst b = 2;\nreturn a + b;\n```")).toBe(false);
    expect(isDegenerateText("| kolom | nilai |\n| --- | --- |\n| a | 1 |\n| b | 2 |")).toBe(false);
    expect(isDegenerateText("")).toBe(false);
    expect(isDegenerateText("short")).toBe(false);
  });

  it("returns false for non-string input", () => {
    expect(isDegenerateText(null)).toBe(false);
    expect(isDegenerateText(undefined)).toBe(false);
    expect(isDegenerateText(42)).toBe(false);
  });

  it("is wired into the combo classifier before the outcome stamp", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../open-sse/services/combo.js", import.meta.url), "utf8");
    const guard = src.indexOf("isDegenerateText(text)");
    const stamp = src.indexOf("out = classifyOutcome(text, true)");
    expect(guard).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(stamp);
    expect(src).toContain("return { outcome: 'SENYAP', bad: true, text }");
  });
});
