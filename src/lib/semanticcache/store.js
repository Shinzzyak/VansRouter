/**
 * Bounded in-memory LRU store for cached completions.
 *
 * A JS Map preserves insertion order, so the LRU needs no separate eviction
 * list: a hit re-inserts the key to move it to the newest position, and the
 * oldest key is always the first one the iterator yields. That is the whole
 * mechanism — roughly a tenth of the code a hand-rolled linked list would take.
 *
 * ponytail: memory only. Entries do not survive a restart, so the first request
 * after a deploy is a miss. Add a SQLite write-through tier when cross-restart
 * hits are worth a synchronous disk write on the completion path.
 */

/** @typedef {{ model: string, body: string, contentType: string, storedAt: number, hitCount: number, tokensSaved: number }} CacheEntry */

export class LruStore {
  /**
   * @param {number} maxEntries entries to keep before evicting the oldest
   * @param {number} ttlMs lifetime of an entry; 0 disables expiry
   */
  constructor(maxEntries = 1000, ttlMs = 24 * 60 * 60 * 1000) {
    this.maxEntries = maxEntries > 0 ? maxEntries : 1000;
    this.ttlMs = ttlMs > 0 ? ttlMs : 0;
    /** @type {Map<string, CacheEntry>} */
    this.items = new Map();
  }

  /** Returns the live entry for key, or null when missing or expired. */
  get(key) {
    const entry = this.items.get(key);
    if (!entry) return null;

    if (this.ttlMs > 0 && Date.now() - entry.storedAt > this.ttlMs) {
      this.items.delete(key);
      return null;
    }

    // Re-insert to mark this key as most recently used.
    this.items.delete(key);
    this.items.set(key, entry);
    return entry;
  }

  /** Stores an entry, evicting the oldest keys once the bound is reached. */
  put(key, entry) {
    this.items.delete(key);
    this.items.set(key, entry);

    while (this.items.size > this.maxEntries) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }

  /** Removes one key. Returns true when something was removed. */
  delete(key) {
    return this.items.delete(key);
  }

  /** Bumps the hit counters for a key that is still present. */
  recordHit(key, tokensSaved) {
    const entry = this.items.get(key);
    if (!entry) return;
    entry.hitCount += 1;
    entry.tokensSaved += tokensSaved;
  }

  /** Live entries, newest first. Expired entries are skipped and dropped. */
  entries() {
    const now = Date.now();
    const live = [];
    for (const [key, entry] of this.items) {
      if (this.ttlMs > 0 && now - entry.storedAt > this.ttlMs) {
        this.items.delete(key);
        continue;
      }
      live.push({ key, ...entry });
    }
    return live.reverse();
  }

  /** Drops every entry whose model matches. Returns how many were dropped. */
  invalidateByModel(model) {
    let count = 0;
    for (const [key, entry] of this.items) {
      if (entry.model === model) {
        this.items.delete(key);
        count += 1;
      }
    }
    return count;
  }

  /** Drops every entry stored more than ageMs ago. Returns how many. */
  invalidateOlderThan(ageMs) {
    const cutoff = Date.now() - ageMs;
    let count = 0;
    for (const [key, entry] of this.items) {
      if (entry.storedAt < cutoff) {
        this.items.delete(key);
        count += 1;
      }
    }
    return count;
  }

  len() {
    return this.items.size;
  }

  clear() {
    this.items.clear();
  }
}
