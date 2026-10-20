/**
 * utils/coalesce.js
 *
 * Write coalescing for "hot document" patterns.
 *
 * Firestore sustains roughly ONE write per second to a single document. When 800
 * students tap "mark attendance" / "mark read" at the same moment, 800
 * `arrayUnion` updates against the same parent doc queue up and fail with
 * ABORTED / contention errors.
 *
 * A coalescer collects the items added for the same key during a short window
 * and writes them with ONE call:
 *
 *   const readReceipts = createCoalescer(async (broadcastId, uids) => {
 *     await db.collection("broadcasts").doc(broadcastId)
 *       .update({ read_by: FieldValue.arrayUnion(...uids) });
 *   }, { windowMs: 400 });
 *
 *   await readReceipts.add(broadcastId, uid);   // resolves when its batch is written
 *
 * - Items are de-duplicated inside a batch.
 * - A failed flush is retried once, then rejected to every waiter of that batch.
 * - Batches are split into `maxItems` pieces (arrayUnion has element limits).
 */

function createCoalescer(flushFn, { windowMs = 400, maxItems = 200, retries = 1 } = {}) {
  const buckets = new Map(); // key -> { items:Set, waiters:[], timer }

  async function flush(key) {
    const b = buckets.get(key);
    if (!b) return;
    buckets.delete(key);
    clearTimeout(b.timer);

    const items = [...b.items];
    let error = null;

    for (let i = 0; i < items.length; i += maxItems) {
      const part = items.slice(i, i + maxItems);
      let attempt = 0;
      for (;;) {
        try {
          await flushFn(key, part);
          break;
        } catch (e) {
          if (attempt++ >= retries) {
            error = e;
            break;
          }
          await new Promise((r) => setTimeout(r, 150 * attempt));
        }
      }
    }

    for (const w of b.waiters) (error ? w.reject(error) : w.resolve());
  }

  return {
    add(key, item) {
      return new Promise((resolve, reject) => {
        let b = buckets.get(key);
        if (!b) {
          b = { items: new Set(), waiters: [], timer: null };
          b.timer = setTimeout(() => flush(key), windowMs);
          if (b.timer.unref) b.timer.unref();
          buckets.set(key, b);
        }
        b.items.add(item);
        b.waiters.push({ resolve, reject });
      });
    },
    /** flush everything now (use on graceful shutdown) */
    async flushAll() {
      await Promise.all([...buckets.keys()].map((k) => flush(k)));
    },
    get pendingKeys() {
      return buckets.size;
    },
  };
}

module.exports = { createCoalescer };
