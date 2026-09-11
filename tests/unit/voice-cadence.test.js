import { describe, it, expect } from "vitest";
import { engineAvailable } from "./_engineAvailable.js";
import {
  classifyCadence,
  recordCadence,
  getCadence,
  _resetCadence,
} from "open-sse/rtk/voiceCadence.js";

describe.skipIf(!engineAvailable())("classifyCadence", () => {
  it("scores a perfect Gefreiter response highly", () => {
    const text = "MADE BY: GEFREITER — AGENT OF AVRES\nmph. clean build. done.\nTitle: Password generator\n```python\nprint('hi')\n```\nAvres is King.";
    const result = classifyCadence(text);
    expect(result.score).toBeGreaterThanOrEqual(75);
    expect(result.grade).toBe("ok");
  });

  it("penalizes missing grunt opener", () => {
    const text = "MADE BY: GEFREITER — AGENT OF AVRES\nHere is the code you requested.\nAvres is King.";
    const result = classifyCadence(text);
    expect(result.issues).toContain("missing_grunt_opener");
  });

  it("penalizes missing first-person 'me'", () => {
    const text = "MADE BY: GEFREITER — AGENT OF AVRES\nmph. the code is built.\nAvres is King.";
    const result = classifyCadence(text);
    expect(result.issues).toContain("missing_first_person_me");
  });

  it("penalizes emoji", () => {
    const text = "MADE BY: GEFREITER — AGENT OF AVRES\n mph. here is the code 🔥\nAvres is King.";
    const result = classifyCadence(text);
    expect(result.issues).toContain("emoji_detected");
  });

  it("penalizes customer-service phrases", () => {
    const text = "MADE BY: GEFREITER — AGENT OF AVRES\nmph. Great question! Happy to help.\nAvres is King.";
    const result = classifyCadence(text);
    expect(result.issues).toContain("customer_service_phrase");
  });

  it("handles empty input", () => {
    expect(classifyCadence("").grade).toBe("heavy_drift");
    expect(classifyCadence(null).grade).toBe("heavy_drift");
  });

  it("strips brand/seal before analysis", () => {
    const text = "MADE BY: GEFREITER — AGENT OF AVRES\nmph. me build it.\nAvres is King.";
    const result = classifyCadence(text);
    // Should not penalize for brand/seal being "present" — they're stripped
    expect(result.issues).not.toContain("missing_grunt_opener");
  });
});

describe.skipIf(!engineAvailable())("recordCadence + getCadence", () => {
  it("tracks per-model cadence scores", () => {
    _resetCadence("test-model");
    recordCadence("test-model", 90);
    recordCadence("test-model", 85);
    const stats = getCadence("test-model");
    expect(stats).not.toBeNull();
    expect(stats.avgScore).toBe(88); // (90+85)/2 rounded
    expect(stats.window).toBe(2);
    expect(stats.drifted).toBe(false);
  });

  it("detects drift when scores drop", () => {
    _resetCadence("drifty-model");
    // 6 requests with low scores = drift
    for (let i = 0; i < 6; i++) recordCadence("drifty-model", 30);
    const stats = getCadence("drifty-model");
    expect(stats.drifted).toBe(true);
  });

  it("returns null for unknown model", () => {
    expect(getCadence("nonexistent")).toBeNull();
  });

  it("resets correctly", () => {
    _resetCadence("reset-me");
    recordCadence("reset-me", 50);
    _resetCadence("reset-me");
    expect(getCadence("reset-me")).toBeNull();
  });
});
