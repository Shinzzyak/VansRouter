// Guards the AgentRouter registry entry (Claude-format passthrough provider).
// AgentRouter proxies to agentrouter.org/v1/messages using x-api-key auth and
// full Claude CLI header spoofing (required by AgentRouter for client validation).
import { describe, it, expect } from "vitest";
import agentrouter from "../../open-sse/providers/registry/agentrouter.js";
import { AI_PROVIDERS, FREE_TIER_PROVIDERS, getAclProviderList } from "@/shared/constants/providers";

describe("agentrouter registry entry", () => {
  it("exposes the canonical identity fields", () => {
    expect(agentrouter.id).toBe("agentrouter");
    expect(agentrouter.alias).toBe("agentrouter");
    expect(agentrouter.uiAlias).toBe("agentrouter");
  });

  it("is a free-tier, apikey, passthrough LLM-only provider", () => {
    expect(agentrouter.category).toBe("freeTier");
    expect(agentrouter.authType).toBe("apikey");
    expect(agentrouter.hasOAuth).toBe(false);
    expect(agentrouter.authModes).toEqual(["apikey"]);
    expect(agentrouter.serviceKinds).toEqual(["llm"]);
    expect(agentrouter.passthroughModels).toBe(true);
  });

  it("declares the Claude-format transport with x-api-key auth + retry policy", () => {
    const t = agentrouter.transport;
    expect(t.baseUrl).toBe("https://agentrouter.org/v1/messages");
    expect(t.format).toBe("claude");
    expect(t.timeoutMs).toBe(600000);
    expect(t.auth.apiKey).toMatchObject({
      header: "x-api-key",
    });
    expect(t.retry).toMatchObject({
      429: { attempts: 3, delayMs: 500 },
      502: { attempts: 3, delayMs: 500 },
      503: { attempts: 3, delayMs: 1000 },
    });
  });

  it("sends full Claude CLI spoofing headers for client validation", () => {
    const headers = agentrouter.transport.headers || {};
    // AgentRouter validates these to ensure the request comes from a Claude CLI client.
    expect(headers["User-Agent"]).toBe("claude-cli/2.1.187 (external, cli)");
    expect(headers["X-App"]).toBe("cli");
    expect(headers["Anthropic-Dangerous-Direct-Browser-Access"]).toBe("true");
    expect(headers["Anthropic-Beta"]).toContain("claude-code-20250219");
    expect(headers["X-Stainless-Lang"]).toBeTruthy();
  });

  it("requires stream:true (forceStream) because AgentRouter rejects non-streaming", () => {
    expect(agentrouter.transport.forceStream).toBe(true);
  });

  it("carries display + free-credit hint", () => {
    expect(agentrouter.display.name).toBe("AgentRouter");
    expect(agentrouter.display.website).toBe("https://agentrouter.org");
    const hint = "Get $200 free credits at https://agentrouter.org/register — no credit card required.";
    expect(agentrouter.display.notice.apiHint).toBe(hint);
    // Current provider-detail UI renders notice.text / notice.apiKeyUrl.
    expect(agentrouter.display.notice.text).toBe(hint);
    expect(agentrouter.display.notice.apiKeyUrl).toBe("https://agentrouter.org/register");
  });
});

describe("agentrouter integration via providers.js", () => {
  it("is registered in AI_PROVIDERS and FREE_TIER_PROVIDERS", () => {
    expect(AI_PROVIDERS.agentrouter).toBeTruthy();
    expect(FREE_TIER_PROVIDERS.agentrouter).toBeTruthy();
    expect(AI_PROVIDERS.agentrouter.id).toBe("agentrouter");
    expect(AI_PROVIDERS.agentrouter.alias).toBe("agentrouter");
    expect(AI_PROVIDERS.agentrouter.passthroughModels).toBe(true);
  });

  it("appears in the derived ACL provider picker (non-hidden, apikey)", () => {
    const list = getAclProviderList();
    const entry = list.find((p) => p.alias === "agentrouter");
    expect(entry).toBeTruthy();
    expect(entry.name).toBe("AgentRouter");
  });
});
