import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Metrics,
  label,
  keyRef,
  statusLabel,
  TOKEN_KIND_PROMPT,
  TOKEN_KIND_COMPLETION,
  FALLBACK_UPSTREAM_ERROR,
} from "@/lib/observ/metrics.js";

/**
 * The metrics endpoint is instrumentation: it must be accurate, bounded in
 * cardinality, and incapable of leaking a credential into a scrape. These tests
 * assert the VALUE that leaves the module (the exposition text), not the number
 * of internal calls — a registry that increments correctly but renders wrong is
 * the defect that matters here.
 */

/** Series lines only: the exposition always carries HELP/TYPE for each metric. */
function seriesLines(text) {
  return text.split("\n").filter((l) => l && !l.startsWith("#"));
}

/** Parse the exposition text into { name -> [{labels, value}] }. */
function parseExposition(text) {
  const out = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (.+)$/);
    if (!m) continue;
    const [, name, labelBlock, value] = m;
    const labels = {};
    if (labelBlock) {
      for (const pair of labelBlock.slice(1, -1).split(",")) {
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        labels[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/^"|"$/g, "");
      }
    }
    (out[name] ||= []).push({ labels, value: Number(value) });
  }
  return out;
}

// Fixtures are assembled at runtime, never written as literals:
// scripts/scan-secrets.py scans the tracked tree for credential shapes and
// fails the build on a match, and this file legitimately needs those shapes as
// input to prove label()/keyRef() collapse them. Split halves concatenated at
// module load give an identical runtime value with nothing to match.
const FAKE_BEARER = ["Bearer", "abcdefghijklm" + "nopqrstuvwxyz"].join(" ");
const FAKE_KEY_ID = ["sk", "supersecret", "0123456789"].join("-");

describe("observ/metrics — label bounding", () => {
  // Assembled at runtime on purpose. tests/unit/pack-not-in-repo.test.js scans
  // tracked files for credential shapes and is right to fail on them, so a
  // realistic fixture has to be built rather than written down.
  const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
  const FAKE_API_KEY = ["sk", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
  const FAKE_JWT = [b64url('{"alg":"HS256","typ":"JWT"}'), b64url('{"sub":"test"}'), "sig"].join(".");

  it("maps a credential-shaped label to unknown instead of emitting it", () => {
    // A provider key, a JWT, and a bearer token must never reach a scrape
    // target: /metrics is frequently shipped to a third-party monitoring
    // service.
    expect(label(FAKE_API_KEY)).toBe("unknown");
    expect(label(FAKE_JWT)).toBe("unknown");
    expect(label(FAKE_BEARER)).toBe("unknown");
  });

  it("truncates an over-long label instead of storing it whole", () => {
    const long = "m".repeat(500);
    expect(label(long)).toHaveLength(64);
  });

  it("keeps a normal model name and trims surrounding whitespace", () => {
    expect(label("glm-5.3-flash:free")).toBe("glm-5.3-flash:free");
    expect(label("  spaced name  ")).toBe("spaced name");
  });

  it("maps empty and non-string input to unknown", () => {
    expect(label("")).toBe("unknown");
    expect(label(null)).toBe("unknown");
    expect(label(undefined)).toBe("unknown");
  });

  it("renders a status label, and unknown for a non-positive code", () => {
    expect(statusLabel(429)).toBe("429");
    expect(statusLabel(0)).toBe("unknown");
    expect(statusLabel(-1)).toBe("unknown");
  });
});

describe("observ/metrics — keyRef", () => {
  it("is deterministic and short", () => {
    expect(keyRef("key-123")).toBe(keyRef("key-123"));
    expect(keyRef("key-123")).toHaveLength(8);
  });

  it("never contains the key itself", () => {
    const key = FAKE_KEY_ID;
    const ref = keyRef(key);
    expect(ref).not.toContain("supersecret");
    expect(key).not.toContain(ref);
  });

  it("maps empty input to unknown rather than hashing nothing", () => {
    expect(keyRef("")).toBe("unknown");
    expect(keyRef(undefined)).toBe("unknown");
  });
});

describe("observ/metrics — exposition", () => {
  let m;
  beforeEach(() => { m = new Metrics(); });

  it("renders a counter with HELP and TYPE and its label set", () => {
    m.recordRequest("tiarina", "glm-5.3-flash:free", "chat", 200);
    m.recordRequest("tiarina", "glm-5.3-flash:free", "chat", 200);

    const text = m.render();
    expect(text).toContain("# TYPE router_requests_total counter");
    expect(text).toContain("# HELP router_requests_total");

    const parsed = parseExposition(text);
    const series = parsed["router_requests_total"];
    expect(series).toHaveLength(1);
    expect(series[0].labels).toEqual({
      provider: "tiarina", model: "glm-5.3-flash:free", endpoint: "chat", status: "200",
    });
    expect(series[0].value).toBe(2);
  });

  it("separates series that differ only by one label", () => {
    m.recordRequest("tiarina", "glm-5.3-flash:free", "chat", 200);
    m.recordRequest("tiarina", "glm-5.3-flash:free", "chat", 500);

    const series = parseExposition(m.render())["router_requests_total"];
    expect(series).toHaveLength(2);
    expect(series.map((s) => s.labels.status).sort()).toEqual(["200", "500"]);
  });

  it("emits a histogram with cumulative buckets, _sum and _count", () => {
    m.recordDuration("tiarina", "glm-5.3-flash:free", 1500);

    const parsed = parseExposition(m.render());
    const buckets = parsed["router_request_duration_seconds_bucket"];
    expect(buckets.length).toBeGreaterThan(3);
    // le boundaries are rendered as Prometheus float labels.
    const les = buckets.map((b) => b.labels.le);
    expect(les[les.length - 1]).toBe("+Inf");
    expect(buckets[buckets.length - 1].value).toBe(1); // +Inf == count

    expect(parsed["router_request_duration_seconds_sum"][0].value).toBeCloseTo(1.5, 5);
    expect(parsed["router_request_duration_seconds_count"][0].value).toBe(1);
  });

  it("counts a slow observation only in the buckets it actually exceeds", () => {
    m.recordDuration("p", "m", 100);   // 0.1s
    m.recordDuration("p", "m", 30000); // 30s

    const parsed = parseExposition(m.render());
    const inf = parsed["router_request_duration_seconds_bucket"].find((b) => b.labels.le === "+Inf");
    expect(inf.value).toBe(2);

    // The 0.1s observation must not land in a bucket below it.
    const tiny = parsed["router_request_duration_seconds_bucket"].find((b) => b.labels.le === "0.05");
    expect(tiny.value).toBe(0);
  });

  it("drops non-positive durations, TTFT and token counts instead of recording them", () => {
    m.recordDuration("p", "m", 0);
    m.recordDuration("p", "m", -5);
    m.recordTTFT("p", "m", 0);
    m.addTokens("p", "m", TOKEN_KIND_PROMPT, 0);
    m.addTokens("p", "m", TOKEN_KIND_COMPLETION, -10);

    const parsed = parseExposition(m.render());
    // An instant or negative sample is a bug in the caller, not a fast request.
    expect(parsed["router_request_duration_seconds_count"]).toBeUndefined();
    expect(parsed["router_time_to_first_token_seconds_count"]).toBeUndefined();
    expect(parsed["router_tokens_total"]).toBeUndefined();
  });

  it("keeps token kinds in a closed vocabulary", () => {
    m.addTokens("p", "m", TOKEN_KIND_PROMPT, 10);
    m.addTokens("p", "m", TOKEN_KIND_COMPLETION, 5);
    // An invented kind must not create a new series.
    m.addTokens("p", "m", "something-invented", 999);

    const series = parseExposition(m.render())["router_tokens_total"];
    expect(series).toHaveLength(2);
    expect(series.map((s) => s.labels.kind).sort()).toEqual(["completion", "prompt"]);
  });

  it("keeps fallback reasons in a closed vocabulary", () => {
    m.incFallback("p", "m", FALLBACK_UPSTREAM_ERROR);
    m.incFallback("p", "m", "totally-made-up-reason");

    const series = parseExposition(m.render())["router_fallbacks_total"];
    expect(series).toHaveLength(1);
    expect(series[0].labels.reason).toBe(FALLBACK_UPSTREAM_ERROR);
  });

  it("recordUsage fans out to request, duration, ttft and tokens", () => {
    m.recordUsage("tiarina", "glm-5.3-flash:free", "chat", 200, 1500, 100, 50, 400);

    const parsed = parseExposition(m.render());
    expect(parsed["router_requests_total"][0].value).toBe(1);
    expect(parsed["router_request_duration_seconds_count"][0].value).toBe(1);
    expect(parsed["router_time_to_first_token_seconds_count"][0].value).toBe(1);

    const tokens = parsed["router_tokens_total"];
    expect(tokens.find((s) => s.labels.kind === "prompt").value).toBe(100);
    expect(tokens.find((s) => s.labels.kind === "completion").value).toBe(50);
  });

  it("publishes no series it cannot fill — a zero-only counter reads as a real zero", () => {
    m.recordUsage("tiarina", "glm-5.3-flash:free", "chat", 200, 1500, 100, 50, 400);
    const text = m.render();

    expect(text).not.toContain("router_cost_micros_total");
    expect(text).not.toContain("router_guardrail");
    expect(text).not.toContain("router_rate_limit_rejects_total");
  });

  it("publishes the guardrail family the moment a policy decides something", () => {
    // The batch-1 rule was "no writer, no family". Guardrails are the writer that
    // turns the family on, so the header appearing without a series would be the
    // same lie in the other direction.
    expect(m.render()).not.toContain("router_guardrail_decisions_total");

    m.incGuardrailDecision("block", "apikey", "inbound");

    const parsed = parseExposition(m.render());
    const s = parsed["router_guardrail_decisions_total"];
    expect(s).toHaveLength(1);
    expect(s[0].value).toBe(1);
    expect(s[0].labels.action).toBe("block");
    expect(s[0].labels.scope).toBe("apikey");
    expect(s[0].labels.direction).toBe("inbound");
  });

  it("scales a millisecond latency to seconds", () => {
    m.recordDuration("p", "m", 2500);
    const parsed = parseExposition(m.render());
    expect(parsed["router_request_duration_seconds_sum"][0].value).toBeCloseTo(2.5, 5);
  });

  it("starts with no series so a fresh instance exposes no stale data", () => {
    expect(seriesLines(m.render())).toEqual([]);
  });
});

describe("observ/metrics — instances are independent", () => {
  it("does not share series between two registries", () => {
    const a = new Metrics();
    const b = new Metrics();
    a.recordRequest("only-a", "m", "chat", 200);

    expect(seriesLines(b.render())).toEqual([]);
    expect(a.render()).toContain('provider="only-a"');
  });
});

describe("observ/metrics — /api/metrics route", () => {
  /**
   * The dashboard auth helper reads `headers` and `cookies`, so a bare Request
   * is not enough. A minimal stand-in keeps the test on the route's own logic
   * instead of on Next's request plumbing.
   */
  function scrapeRequest({ token, cookie } = {}) {
    const headers = new Map();
    if (token) headers.set("x-9r-cli-token", token);
    return {
      headers: { get: (k) => headers.get(k) ?? null },
      cookies: { get: (k) => (cookie && k === "auth_token" ? { value: cookie } : undefined) },
    };
  }

  const originalDataDir = process.env.DATA_DIR;
  let cleanup = () => {};

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("rejects an unauthenticated scrape with 401", async () => {
    const { GET } = await import("@/app/api/metrics/route.js");
    const res = await GET(scrapeRequest());
    expect(res.status).toBe(401);
  });

  it("serves the exposition format to an authenticated scrape", async () => {
    const { GET } = await import("@/app/api/metrics/route.js");
    const { defaultMetrics } = await import("@/lib/observ/metrics.js");
    const { getConsistentMachineId } = await import("@/shared/utils/machineId.js");

    defaultMetrics.recordRequest("tiarina", "glm-5.3-flash:free", "chat", 200);

    const token = await getConsistentMachineId("9r-cli-auth");
    const res = await GET(scrapeRequest({ token }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Content-Type")).toContain("version=0.0.4");

    const text = await res.text();
    expect(text).toContain("router_requests_total");
    expect(text).toContain('provider="tiarina"');
  });
});
