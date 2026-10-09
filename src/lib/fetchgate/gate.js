/**
 * Paces outbound requests that a burst of callers would otherwise fire in the
 * same millisecond.
 *
 * The motivating case: the dashboard quota tracker refreshes every visible
 * connection at once (`Promise.allSettled(connections.map(fetchQuota))`). Ten
 * accounts behind one office NAT therefore sent ten quota reads within a few
 * milliseconds, the provider answered 429, and the chat path read that as real
 * quota exhaustion — locking accounts that still had live tokens.
 *
 * A gate is the general fix. Callers await a slot before their request goes out,
 * and the gate hands out at most one slot per minimum gap, so a fleet behind one
 * NAT stops looking like a fleet. The cost is that the last read finishes a
 * couple of seconds later.
 *
 * Jitter is additive rather than a window around the gap, so `minGapMs` stays a
 * hard floor that operators and tests can rely on.
 */
export class FetchGate {
  /**
   * @param {number} minGapMs minimum spacing between consecutive slots
   * @param {number} maxJitterMs extra random delay, drawn per slot
   */
  constructor(minGapMs = 0, maxJitterMs = 0) {
    this.minGapMs = Math.max(minGapMs, 0);
    this.maxJitterMs = Math.max(maxJitterMs, 0);
    /** Earliest instant the next slot may start. */
    this.next = 0;
  }

  /**
   * Reserves the next slot and waits until it opens.
   *
   * The reservation is taken before the wait, so a caller that gives up still
   * consumed its slot — that is what stops a stampede from re-collapsing into
   * the slot the next caller takes.
   *
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<void>} rejects when the signal aborts first
   */
  async acquire({ signal } = {}) {
    const now = Date.now();
    const start = Math.max(now, this.next);
    this.next = start + this.minGapMs + this.jitter();

    const wait = start - now;
    if (wait <= 0) return;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      }, wait);

      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("FetchGate.acquire: aborted"));
      };

      if (signal?.aborted) return onAbort();
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }

  /** Extra delay for one slot. 0 when jitter is disabled. */
  jitter() {
    if (this.maxJitterMs <= 0) return 0;
    return Math.floor(Math.random() * (this.maxJitterMs + 1));
  }

  /** Milliseconds until the next slot opens. 0 when one is free now. */
  waitMs() {
    return Math.max(0, this.next - Date.now());
  }
}

/**
 * Shared gate for dashboard-triggered bursts.
 *
 * 150ms of spacing turns a 50-connection batch from 50 simultaneous upstream
 * calls into about 7/s, and the 40ms of jitter keeps two routers behind the same
 * NAT from re-synchronising on the same instants.
 */
export const defaultGate = new FetchGate(
  Number(process.env.FETCH_GATE_GAP_MS ?? 150),
  Number(process.env.FETCH_GATE_JITTER_MS ?? 40)
);
