/**
 * utils/students.js
 *
 * Student profile lookups for the attendance endpoints.
 *
 * The original looked a student up with `students.where("uid","==",uid).limit(1)` on every
 * (uncached) request. When 300 students tap "mark attendance" together that is 300 queries.
 *
 * getStudentByUid() / getStudentByRoll():
 *   - remember the profile for a few minutes (profiles rarely change during a lecture)
 *   - collect all lookups made within ~15 ms and read them with ONE batched call
 *     (document-id read first - students/{uid} is the normal layout - then a `uid in [...]`
 *     query only for the ids that were not found, e.g. documents with an auto id)
 */

const { db } = require("../config/firebase");
const { TTLCache } = require("./cache");
const { chunk } = require("./firestore");

const cache = new TTLCache({ max: 20_000, ttlMs: 5 * 60_000 });
const rollCache = new TTLCache({ max: 20_000, ttlMs: 5 * 60_000 });

let pending = new Map(); // uid -> [{resolve, reject}]
let timer = null;

async function loadMany(uids) {
  const found = new Map();

  for (const part of chunk(uids, 200)) {
    const snaps = await db.getAll(...part.map((u) => db.collection("students").doc(u)));
    for (const s of snaps) if (s.exists) found.set(s.id, s.data());
  }

  const missing = uids.filter((u) => !found.has(u));
  if (missing.length) {
    const results = await Promise.all(
      chunk(missing, 30).map((c) => db.collection("students").where("uid", "in", c).get())
    );
    for (const r of results) {
      for (const d of r.docs) {
        const data = d.data();
        if (!found.has(data.uid)) found.set(data.uid, data);
      }
    }
  }
  return found;
}

function flush() {
  const batch = pending;
  pending = new Map();
  timer = null;
  const uids = [...batch.keys()];
  loadMany(uids).then(
    (found) => {
      for (const [uid, waiters] of batch) {
        const data = found.get(uid) || null;
        if (data) cache.set(uid, data);
        waiters.forEach((w) => w.resolve(data));
      }
    },
    (err) => {
      for (const waiters of batch.values()) waiters.forEach((w) => w.reject(err));
    }
  );
}

/** student document data for an auth uid, or null */
function getStudentByUid(uid) {
  if (typeof uid !== "string" || !uid || uid.includes("/")) return Promise.resolve(null);
  const hit = cache.get(uid);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    let w = pending.get(uid);
    if (!w) pending.set(uid, (w = []));
    w.push({ resolve, reject });
    if (!timer) timer = setTimeout(flush, 15);
  });
}

/** student document data for a roll_number (optionally inside one college), or null */
function getStudentByRoll(roll, aishe_code) {
  const key = `${aishe_code || "*"}|${roll}`;
  return rollCache.memo(key, 5 * 60_000, async () => {
    let q = db.collection("students").where("roll_number", "==", roll);
    if (aishe_code) q = q.where("aishe_code", "==", aishe_code);
    const snap = await q.limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  });
}

/** drop the remembered profile (after the student's division or semester changed) */
function forgetStudent(uid) {
  if (typeof uid === "string") cache.del(uid);
}

module.exports = { getStudentByUid, getStudentByRoll, forgetStudent };