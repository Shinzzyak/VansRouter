import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchGate } from "@/lib/fetchgate/gate.js";

describe("fetchgate — FetchGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hands the first slot out immediately", async () => {
    const gate = new FetchGate(1000, 0);
    let resolved = false;
    const p = gate.acquire().then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
    await p;
  });

  it("spaces consecutive slots by at least the minimum gap", async () => {
    const gate = new FetchGate(500, 0);
    const starts = [];

    const wait = (async () => { await gate.acquire(); starts.push(Date.now()); })();
    await vi.advanceTimersByTimeAsync(0);
    const second = (async () => { await gate.acquire(); starts.push(Date.now()); })();
    const third = (async () => { await gate.acquire(); starts.push(Date.now()); })();

    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([wait, second, third]);

    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(500);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(500);
  });

  it("keeps the minimum gap as a hard floor when jitter is on", async () => {
    const gate = new FetchGate(200, 200);
    const starts = [];

    for (let i = 0; i < 5; i += 1) {
      void (async () => { await gate.acquire(); starts.push(Date.now()); })();
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(10_000);

    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(200);
    }
  });

  it("reports no wait when the next slot is already open", () => {
    const gate = new FetchGate(500, 0);
    expect(gate.waitMs()).toBe(0);
  });

  it("reports a positive wait once a slot has been reserved", async () => {
    const gate = new FetchGate(500, 0);
    void gate.acquire();
    expect(gate.waitMs()).toBeGreaterThan(0);
  });

  it("rejects when the signal aborts while waiting", async () => {
    const gate = new FetchGate(5000, 0);
    void gate.acquire(); // consume the immediate slot

    const controller = new AbortController();
    const pending = gate.acquire({ signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow(/aborted/);

    controller.abort();
    await assertion;
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const gate = new FetchGate(5000, 0);
    void gate.acquire();

    const controller = new AbortController();
    controller.abort();
    await expect(gate.acquire({ signal: controller.signal })).rejects.toThrow(/aborted/);
  });

  it("clamps a negative gap and jitter to zero", async () => {
    const gate = new FetchGate(-100, -100);
    expect(gate.minGapMs).toBe(0);
    expect(gate.maxJitterMs).toBe(0);
    expect(gate.jitter()).toBe(0);

    const starts = [];
    for (let i = 0; i < 3; i += 1) { await gate.acquire(); starts.push(Date.now()); }
    expect(starts[1]).toBe(starts[0]);
  });
});
