/**
 * utils/firestore.js
 *
 * Shared Firestore helpers used by the optimised route files.
 */

const { admin, db } = require("../config/firebase");

const IN_LIMIT = 30; // Firestore: max values for `in` / `array-contains-any`

function chunk(arr, size = IN_LIMIT) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Run `build(chunkOfValues)` (must return a Firestore Query) for every chunk of
 * `values` IN PARALLEL and return one flat array of QueryDocumentSnapshots.
 * (The originals ran the chunks one after another.)
 */
async function queryInChunks(values, build, size = IN_LIMIT) {
  const uniq = [...new Set(values.filter((v) => v !== undefined && v !== null))];
  if (!uniq.length) return [];
  const snaps = await Promise.all(chunk(uniq, size).map((c) => build(c).get()));
  const docs = [];
  for (const s of snaps) for (const d of s.docs) docs.push(d);
  return docs;
}

/**
 * Fetch many documents by id in as few round-trips as possible.
 * Returns a Map(id -> DocumentSnapshot) containing only documents that exist.
 * `fields` optionally limits the fields that are transferred.
 */
async function getDocsByIds(collection, ids, fields) {
  const uniq = [...new Set(ids.filter(Boolean))];
  const map = new Map();
  if (!uniq.length) return map;

  const parts = chunk(uniq, 200);
  const results = await Promise.all(
    parts.map((part) => {
      const refs = part.map((id) => db.collection(collection).doc(id));
      return fields && fields.length
        ? db.getAll(...refs, { fieldMask: fields })
        : db.getAll(...refs);
    })
  );
  for (const snaps of results) for (const s of snaps) if (s.exists) map.set(s.id, s);
  return map;
}

/**
 * Number of documents matching a query WITHOUT reading them
 * (aggregation count = 1 read per 1000 index entries). Falls back to a
 * keys-only read on firebase-admin versions that do not have count().
 */
async function countQuery(query) {
  if (typeof query.count === "function") {
    const snap = await query.count().get();
    return snap.data().count;
  }
  const snap = await query.select().get();
  return snap.size;
}

function toISO(val) {
  if (!val) return null;
  if (typeof val?.toDate === "function") return val.toDate().toISOString();
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

/** `x?.toDate?.()?.toISOString() || null` used all over the originals */
function tsISO(ts) {
  return ts?.toDate?.()?.toISOString() || null;
}

/** Commit writes in batches of <= 450 (Firestore limit is 500 per batch). */
async function commitInBatches(ops) {
  // ops: array of (batch) => void
  for (let i = 0; i < ops.length; i += 450) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + 450)) op(batch);
    await batch.commit();
  }
}

/** Firestore error code helpers */
const isIndexMissing = (e) => e && (e.code === 9 || /FAILED_PRECONDITION|requires an index/i.test(e.message || ""));
const isAlreadyExists = (e) => e && (e.code === 6 || /ALREADY_EXISTS/i.test(e.message || ""));

/** Keep only plain, bounded strings from user input. */
function str(v, max = 500) {
  if (v === undefined || v === null) return v;
  return String(v).slice(0, max);
}

module.exports = {
  admin,
  db,
  IN_LIMIT,
  chunk,
  queryInChunks,
  getDocsByIds,
  countQuery,
  toISO,
  tsISO,
  commitInBatches,
  isIndexMissing,
  isAlreadyExists,
  str,
};
