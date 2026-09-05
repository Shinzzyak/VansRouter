import { describe, it, expect } from "vitest";
import {
  getModelCapabilityProfile,
  classifyResponseFailure,
} from "open-sse/rtk/modelCapabilities.js";

describe("model capability profiles", () => {
  it("detects model family across provider prefixes", () => {
    expect(getModelCapabilityProfile("nar", "nar/muse-spark-1.3-contributor").family).toBe("muse_spark");
    expect(getModelCapabilityProfile("freebuff", "fb/kimi-k3").family).toBe("deepseek");
    expect(getModelCapabilityProfile("antigravity", "gemini-3.7-flash").family).toBe("gemini");
    expect(getModelCapabilityProfile("cbcn", "cbcn/hy4-preview").family).toBe("hunyuan");
  });

  it("marks Muse/Spark as educational-only and classifier-sensitive", () => {
    const profile = getModelCapabilityProfile("nar", "nar/muse-spark-1.3-contributor");
    expect(profile.requestStrategy).toBe("educational_rephrase");
    expect(profile.inputClassifier).toBe(true);
    expect(profile.outputClassifier).toBe(true);
    expect(profile.personaStrategy).toBe("avoid");
  });

  it("uses provider override when model family is unknown", () => {
    const profile = getModelCapabilityProfile("gemini", "vendor-custom-model");
    expect(profile.family).toBe("gemini");
    expect(profile.requestStrategy).toBe("educational");
  });

  it("classifies reasoning null content separately from output filtering", () => {
    expect(classifyResponseFailure({
      status: 200,
      body: { choices: [{ message: { content: null, reasoning_content: "thinking" } }], usage: { completion_tokens: 20 } },
    })).toBe("reasoning_only");
    expect(classifyResponseFailure({
      status: 200,
      body: { choices: [{ message: { content: null } }], usage: { completion_tokens: 20 } },
    })).toBe("output_filtered");
  });

  it("separates safety 400, auth, quota, and infrastructure failures", () => {
    expect(classifyResponseFailure({ status: 400, message: "the model's provider rejected this request" })).toBe("safety_400");
    expect(classifyResponseFailure({ status: 401, message: "invalid api key" })).toBe("auth");
    expect(classifyResponseFailure({ status: 429, message: "rate limit exceeded" })).toBe("quota");
    expect(classifyResponseFailure({ status: 503, message: "upstream unavailable" })).toBe("infrastructure");
  });
});
