// A5 (cases #7/#9/#10): lock hardcode->config no-op values.
import { describe, it, expect } from "vitest";
import {
  OPENAI_COMPAT_BASE,
  ANTHROPIC_COMPAT_BASE,
  ANTHROPIC_API_VERSION,
} from "../../open-sse/providers/shared.js";
import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../open-sse/config/runtimeConfig.js";
import mimoFree from "../../open-sse/providers/registry/mimo-free.js";
import opencode from "../../open-sse/providers/registry/opencode.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";

// Derived, not pinned: the upstream renames Muse Spark between versions and a
// hardcoded id turns a rename into a false RED.
const MUSE = opencode.models.find((m) => /^muse-spark-/.test(m.id))?.id;

describe("compat base URLs / version", () => {
  it("OPENAI_COMPAT_BASE", () => {
    expect(OPENAI_COMPAT_BASE).toBe("https://api.openai.com/v1");
  });
  it("ANTHROPIC_COMPAT_BASE", () => {
    expect(ANTHROPIC_COMPAT_BASE).toBe("https://api.anthropic.com/v1");
  });
  it("ANTHROPIC_API_VERSION", () => {
    expect(ANTHROPIC_API_VERSION).toBe("2023-06-01");
  });
});

describe("default token limits", () => {
  it("max/min", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(64000);
    expect(DEFAULT_MIN_TOKENS).toBe(32000);
  });
});

describe("provider baseUrl const (full path, no trailing slash)", () => {
  it("mimo-free full path", () => {
    expect(mimoFree.transport.baseUrl).toBe("https://api.xiaomimimo.com/api/free-ai/openai/chat");
  });
  it("opencode points at the local bridge, never the upstream that 403s", () => {
    // opencode.ai/zen/v1 gates by TLS/ALPN: a plain HTTP POST from a datacenter
    // IP is 403 FreeTierError whatever the headers. Only the real binary passes,
    // so the provider is served by the local bridge (pm2: opencode-serve +
    // opencode-bridge on :4870) — this const is the whole reason oc/* works.
    expect(opencode.transport.baseUrl).toBe("http://127.0.0.1:4870/v1/chat/completions");
    expect(opencode.transport.baseUrl).not.toContain("opencode.ai");
  });
});

describe("antigravity retry (intentional change: 429=3, 503=3)", () => {
  it("429 attempts = 3", () => {
    expect(antigravity.transport.retry["429"].attempts).toBe(3);
  });
  it("503 attempts = 3", () => {
    expect(antigravity.transport.retry["503"].attempts).toBe(3);
  });
});

describe("OpenCode Free endpoint routing (the bridge owns it)", () => {
  it("declares no format translation — the bridge does that", () => {
    expect(opencode.transport.format).toBeUndefined();
    expect(opencode.models.some((m) => m.targetFormat)).toBe(false);
  });

  it("registers NO specialized executor, because buildUrl would double the bridge path", () => {
    // With no entry in the executors map, getExecutor() falls through to
    // DefaultExecutor, which posts straight to transport.baseUrl (the bridge).
    expect(hasSpecializedExecutor("opencode")).toBe(false);
    expect(getExecutor("opencode").constructor.name).toBe("DefaultExecutor");

    // The reason, locked as a tripwire. OpenCodeExecutor.buildUrl appends
    // /zen/v1/... to whatever baseUrl the registry declares, so registering it
    // would POST to <bridge>/v1/chat/completions/zen/v1/chat/completions and
    // 404 every oc/* call. If this assertion ever goes red, buildUrl changed —
    // re-read the registry header before wiring the executor back in.
    expect(new OpenCodeExecutor().buildUrl("big-pickle")).toBe(
      "http://127.0.0.1:4870/v1/chat/completions/zen/v1/chat/completions",
    );
  });

  it("normalizes Chat token/thinking fields only for the Responses model", () => {
    const executor = new OpenCodeExecutor();
    const muse = { max_tokens: 4096, reasoning_effort: "high" };
    executor.transformRequest(MUSE, muse, true, {});
    expect(muse.max_output_tokens).toBe(4096);
    expect(muse.max_tokens).toBeUndefined();
    expect(muse.reasoning).toEqual({ effort: "high", summary: "auto" });

    const chat = { max_tokens: 4096, reasoning_effort: "high" };
    executor.transformRequest("big-pickle", chat, true, {});
    expect(chat.max_tokens).toBe(4096);
    expect(chat.max_output_tokens).toBeUndefined();
    expect(chat.reasoning_effort).toBe("high");
  });
});
