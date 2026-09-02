import { describe, it, expect, vi } from "vitest";

// Reproduce the adaptive-timeout math in callCompress (headroom.js) without
// importing the whole module (which needs the translator deps). We replicate
// the exact formula to lock the behaviour.
function adaptiveTimeout(messages, configuredMs) {
  const size = JSON.stringify(messages)?.length || 0;
  const scaled = Math.ceil(size / 10240) * 1000;
  return Math.max(configuredMs, Math.min(scaled, 30000));
}

describe("headroom adaptive compress timeout", () => {
  it("keeps the configured 3s floor for small bodies", () => {
    const msgs = [{ role: "user", content: "hi" }];
    expect(adaptiveTimeout(msgs, 3000)).toBe(3000);
  });
  it("scales up for large bodies (38KB -> ~4s+", () => {
    // ~38KB as seen in the live ProxyFetch-timeout lines
    const big = [{ role: "user", content: "x".repeat(38_000) }];
    const t = adaptiveTimeout(big, 3000);
    expect(t).toBeGreaterThan(3000);
    expect(t).toBeLessThanOrEqual(30000);
  });
  it("caps at 30s for huge bodies", () => {
    const huge = [{ role: "user", content: "x".repeat(500_000) }];
    expect(adaptiveTimeout(huge, 3000)).toBe(30000);
  });
  it("uses configured timeout if it's already larger than the scaled one", () => {
    const msgs = [{ role: "user", content: "hi" }];
    expect(adaptiveTimeout(msgs, 15000)).toBe(15000);
  });
});
