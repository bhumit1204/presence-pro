/**
 * utils/limiter.js
 *
 *  rateLimit({ windowMs, max, key })  -> express middleware (fixed window, in-memory)
 *  createGate(n)                      -> run(fn) with at most n concurrent executions
 *
 * The rate limiter is a second line of defence; nginx `limit_req` is the first.
 * It is per-process, which is fine for abuse protection (an attacker spreading
 * over N instances just gets N x the limit).
 *
 * `trust proxy` must be configured on the express app (behind nginx / CloudFront)
 * for req.ip to be the real client address.
 */

const byIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";
const byUidOrIp = (req) => req.auth?.uid || byIp(req);

function rateLimit({
  windowMs = 60_000,
  max = 60,
  key = byIp,
  message = "Too many requests, please slow down.",
  name = "rl",
} = {}) {
  const hits = new Map(); // key -> { n, reset }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.max(10_000, windowMs));
  if (timer.unref) timer.unref();

  return function rateLimitMiddleware(req, res, next) {
    let k;
    try {
      k = `${name}:${key(req)}`;
    } catch {
      return next();
    }
    const now = Date.now();
    let e = hits.get(k);
    if (!e || e.reset <= now) {
      e = { n: 0, reset: now + windowMs };
      hits.set(k, e);
    }
    e.n += 1;
    if (e.n > max) {
      res.set("Retry-After", String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ success: false, error: message });
    }
    // hard cap on tracked keys (memory safety under a flood of unique keys)
    if (hits.size > 100_000) {
      const first = hits.keys().next().value;
      hits.delete(first);
    }
    next();
  };
}

/** Concurrency gate: at most `limit` async jobs run at once, the rest queue FIFO. */
function createGate(limit = 4) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
      });
    },
    get pending() {
      return queue.length;
    },
    get active() {
      return active;
    },
  };
}

/**
 * Reject (503 + Retry-After) when more than `max` requests of this kind are in
 * flight. Use in FRONT of multer memory-storage uploads: each one can hold up to
 * 10 MB in RAM, so 100 simultaneous uploads would otherwise exhaust a small VM.
 */
function limitConcurrent(max = 10, message = "Server is busy, please retry in a few seconds.") {
  let active = 0;
  return function limitConcurrentMiddleware(req, res, next) {
    if (active >= max) {
      res.set("Retry-After", "3");
      return res.status(503).json({ success: false, error: message });
    }
    active += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active -= 1;
      }
    };
    res.on("finish", release);
    res.on("close", release);
    next();
  };
}

/**
 * Like limitConcurrent, but instead of failing straight away a request WAITS
 * (up to maxWaitMs) for a free slot. The body is not read while waiting, so no
 * memory is used. Best for bursts (a whole class uploading at the same minute):
 * everyone gets served, just a little slower. Only when the queue is really
 * long or the wait is too long the client gets 503 + Retry-After.
 */
function queueConcurrent(max = 20, { maxWaitMs = 15_000, maxQueue = 400, message = "Server is busy, please retry in a few seconds." } = {}) {
  let active = 0;
  const waiting = [];
  const grant = () => {
    while (active < max && waiting.length) {
      const w = waiting.shift();
      clearTimeout(w.timer);
      if (w.dead) continue;
      active += 1;
      w.go();
    }
  };
  return function queueConcurrentMiddleware(req, res, next) {
    let released = false;
    let slotTaken = false;
    const release = () => {
      if (released) return;
      released = true;
      if (slotTaken) {
        active -= 1;
        grant();
      } else {
        w.dead = true;
      }
    };
    const w = {
      dead: false,
      timer: null,
      go() {
        slotTaken = true;
        if (released) { active -= 1; grant(); return; }
        next();
      },
    };
    res.on("finish", release);
    res.on("close", release);
    if (active < max) {
      active += 1;
      slotTaken = true;
      return next();
    }
    if (waiting.length >= maxQueue) {
      released = true;
      res.set("Retry-After", "3");
      return res.status(503).json({ success: false, error: message });
    }
    w.timer = setTimeout(() => {
      if (slotTaken || w.dead) return;
      w.dead = true;
      released = true;
      res.set("Retry-After", "3");
      res.status(503).json({ success: false, error: message });
    }, maxWaitMs);
    if (w.timer.unref) w.timer.unref();
    waiting.push(w);
  };
}

module.exports = { rateLimit, createGate, limitConcurrent, queueConcurrent, byIp, byUidOrIp };
