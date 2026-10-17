import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { recordRefusalMetric, getRefusalMetrics, _resetRefusalMetrics } from "../../open-sse/rtk/refusalMetrics.js";

/**
 * K137 — anchor telemetry.
 *
 * `brandOk` is already computed by the integrity classifiers for their own
 * reasons. Reading it as "did the model emit the anchor itself" costs one line
 * and turns persona drift from a suspicion into a counter. A reply that needed
 * repair still ships; it is the RATE that is the signal.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");

describe("K137 anchor drift counter", () => {
  beforeEach(() => _resetRefusalMetrics());

  it("accepts the drift kind instead of silently dropping it", () => {
    recordRefusalMetric("drift", { provider: "z-ai", model: "glm-5.3-flash", anchor: true, path: "stream" });
    expect(getRefusalMetrics().drift).toBe(1);
  });

  it("keeps the existing kinds working", () => {
    recordRefusalMetric("detected", { provider: "p", model: "m" });
    recordRefusalMetric("drift", { provider: "p", model: "m", anchor: false, path: "non-stream" });
    const m = getRefusalMetrics();
    expect(m.detected).toBe(1);
    expect(m.drift).toBe(1);
  });

  it("is wired on both the streaming and non-streaming paths", () => {
    const stream = read("open-sse/handlers/chatCore/streamingHandler.js");
    const nonStream = read("open-sse/handlers/chatCore/nonStreamingHandler.js");
    expect(stream).toContain('recordRefusalMetric("drift"');
    expect(nonStream).toContain('recordRefusalMetric("drift"');
    expect(stream).toContain('path: "stream"');
    expect(nonStream).toContain('path: "non-stream"');
    expect(stream).toContain("anchor: integrity.brandOk === true");
    expect(nonStream).toContain("anchor: integrity.brandOk === true");
  });
});
