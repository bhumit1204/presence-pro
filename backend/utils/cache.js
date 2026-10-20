/**
 * utils/cache.js
 *
 * Small in-process TTL + LRU cache with request coalescing ("single flight").
 *
 *   const cache = new TTLCache({ max: 5000, ttlMs: 30_000 });
 *   const subject = await cache.memo(`subject:${id}`, 30_000, () => loadSubject(id));
 *
 * - memo() makes sure that when 500 requests ask for the same thing at the
 *   same moment, Firestore is hit ONCE and everybody shares the answer.
 * - Errors are never cached.
 * - null / undefined results are cached only when { cacheNull: true } is passed.
 * - Memory is bounded (LRU eviction when `max` is reached).
 *
 * NOTE: this is per-process. With several server instances each instance has
 * its own copy, so only cache data that is OK to be a few seconds stale.
 */

class TTLCache {
  constructor({ max = 5000, ttlMs = 60_000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { v, exp }
    this.inflight = new Map(); // key -> Promise
    // Sweep expired entries so memory does not creep up on idle keys.
    this._timer = setInterval(() => this.sweep(), Math.min(60_000, Math.max(5_000, ttlMs)));
    if (this._timer.unref) this._timer.unref();
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  has(key) {
    const e = this.map.get(key);
    if (!e) return false;
    if (e.exp <= Date.now()) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  set(key, v, ttlMs = this.ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { v, exp: Date.now() + ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return v;
  }

  del(key) {
    this.map.delete(key);
    this.inflight.delete(key);
  }

  /** delete every key that starts with `prefix` */
  delPrefix(prefix) {
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
    for (const k of this.inflight.keys()) if (k.startsWith(prefix)) this.inflight.delete(k);
  }

  clear() {
    this.map.clear();
    this.inflight.clear();
  }

  sweep() {
    const now = Date.now();
    for (const [k, e] of this.map) if (e.exp <= now) this.map.delete(k);
  }

  get size() {
    return this.map.size;
  }

  /**
   * Get-or-load with single-flight.
   * loader() is awaited at most once per key at a time.
   */
  async memo(key, ttlMs, loader, { cacheNull = false } = {}) {
    if (this.has(key)) return this.get(key);

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const p = (async () => {
      try {
        const v = await loader();
        if (v !== undefined && (v !== null || cacheNull)) this.set(key, v, ttlMs);
        return v;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

module.exports = { TTLCache };
