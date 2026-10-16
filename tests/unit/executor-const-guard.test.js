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
  it("opencode points at the upstream /inference/v1 lane, never the local bridge", () => {
    // 2026-10-17: the free-tier gate moved from TLS/ALPN to a request-shape
    // check. Live A/B from this host: /inference/v1 + UA opencode/latest/2.0.26
    // + tools [read, shell] -> 200; the same POST without the fingerprint tools
    // -> 403 FreeTierError. The old bridge (pm2: opencode-serve +
    // opencode-bridge, ~655 MB RSS) was built on the wrong diagnosis and is gone.
    // OpenCodeExecutor.buildUrl appends /inference/v1/... to this base, so it
    // must stay the bare origin.
    expect(opencode.transport.baseUrl).toBe("https://opencode.ai");
    expect(opencode.transport.baseUrl).not.toContain("127.0.0.1");
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

describe("OpenCode Free endpoint routing (the executor owns it)", () => {
  it("declares the non-chat endpoint formats per model", () => {
    // The executor owns the URL; the registry only says which models do not use
    // /chat/completions. muse-spark -> /responses.
    expect(opencode.transport.format).toBeUndefined();
    const byFormat = Object.fromEntries(opencode.models.filter((m) => m.targetFormat).map((m) => [m.id, m.targetFormat]));
    expect(byFormat["muse-spark-1.2-contributor-free"]).toBe("openai-responses");
    expect(byFormat["muse-spark-1.3-contributor-free"]).toBe("openai-responses");

    // union-alpha left the live roster on 2026-10-17 (400 "Model is unavailable."
    // on /inference/v1/messages), so it must not be seeded back in. The /messages
    // lane itself stays owned by the executor, ready for its replacement.
    expect(byFormat["union-alpha"]).toBeUndefined();
    expect(new OpenCodeExecutor().buildUrl("union-alpha")).toBe(
      "https://opencode.ai/inference/v1/messages",
    );
  });

  it("registers OpenCodeExecutor so buildUrl targets /inference/v1", () => {
    // With the executor registered, getExecutor() returns it and buildUrl
    // resolves the /inference/v1 lane the free tier now serves.
    expect(hasSpecializedExecutor("opencode")).toBe(true);
    expect(getExecutor("opencode").constructor.name).toBe("OpenCodeExecutor");

    // Tripwire on the lane: /zen/v1 answers every free request with 403
    // FreeTierError since 2026-10-14, so this URL must stay /inference/v1.
    expect(new OpenCodeExecutor().buildUrl("big-pickle")).toBe(
      "https://opencode.ai/inference/v1/chat/completions",
    );
    expect(new OpenCodeExecutor().buildUrl(MUSE)).toBe("https://opencode.ai/inference/v1/responses");
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
