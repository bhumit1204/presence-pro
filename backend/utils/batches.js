/**
 * utils/batches.js
 *
 * Lab batches: one division's lab class is split into 2 or 3 batches by ROLL NUMBER.
 * Every batch is an ordinary `lectures` document that carries its own roll range:
 *
 *   batch: "B2", batch_no: 2, batch_of: 3,
 *   batch_after: "2330"    // exclusive lower bound  (null for the first batch)
 *   batch_upto:  "2360"    // inclusive upper bound  (null for the last batch)
 *
 * A student belongs to the batch whose range contains their roll number, so students who join later
 * land in the right batch without anybody editing the timetable. A student without a roll number is
 * counted in the LAST batch.
 *
 * The comparison below is deliberately tiny and has no dependency on Intl/locale support,
 * so the mobile apps can copy it verbatim and decide exactly like the server does.
 */

/** "MCA9" < "MCA10", "2301" < "2310", case-insensitive; digits compared as numbers of any length */
function naturalCompare(a, b) {
  const x = String(a == null ? "" : a).trim().toLowerCase();
  const y = String(b == null ? "" : b).trim().toLowerCase();
  const rx = x.match(/\d+|\D+/g) || [];
  const ry = y.match(/\d+|\D+/g) || [];
  const n = Math.min(rx.length, ry.length);
  for (let i = 0; i < n; i++) {
    const p = rx[i], q = ry[i];
    if (/^\d/.test(p) && /^\d/.test(q)) {
      const pn = p.replace(/^0+(?=\d)/, ""), qn = q.replace(/^0+(?=\d)/, "");
      if (pn.length !== qn.length) return pn.length < qn.length ? -1 : 1;
      if (pn !== qn) return pn < qn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return rx.length === ry.length ? 0 : rx.length < ry.length ? -1 : 1;
}

/** a student document's roll number (the registration form stores roll_no; some older documents roll_number) */
function rollOf(s) {
  if (!s) return "";
  const v = s.roll_no != null ? s.roll_no : s.roll_number;
  return v == null ? "" : String(v).trim();
}

/** does a lecture / session carrying batch fields include this roll number? (no batch fields = everybody) */
function inBatch(spec, roll) {
  if (!spec || !spec.batch_no) return true;
  const r = String(roll == null ? "" : roll).trim();
  const after = spec.batch_after == null ? null : spec.batch_after;
  const upto = spec.batch_upto == null ? null : spec.batch_upto;
  if (!r) return upto === null;
  if (after !== null && naturalCompare(r, after) <= 0) return false;
  if (upto !== null && naturalCompare(r, upto) > 0) return false;
  return true;
}

/** the fields of a lecture / session that describe its batch (so they can be copied onto a session) */
function batchFields(l) {
  if (!l || !l.batch_no) return {};
  return { batch: l.batch || `B${l.batch_no}`, batch_no: l.batch_no, batch_of: l.batch_of || null, batch_after: l.batch_after == null ? null : l.batch_after, batch_upto: l.batch_upto == null ? null : l.batch_upto };
}

/**
 * Split `rolls` (roll numbers of the students that attend, blanks allowed) into `count` batches.
 *   cuts: optional, count-1 roll numbers = the LAST roll number of each batch except the last.
 * Returns { ok: true, batches: [{ batch_no, name, after, upto, size }] } or { ok: false, error }.
 */
function planBatches(rolls, count, cuts) {
  count = Number(count);
  if (!Number.isInteger(count) || count < 2 || count > 3) return { ok: false, error: "A lab can be split into 2 or 3 batches" };
  const all = (rolls || []).map((r) => String(r == null ? "" : r).trim());
  const sorted = all.filter(Boolean).sort(naturalCompare);
  const n = all.length;

  let uppers;
  if (Array.isArray(cuts) && cuts.length) {
    uppers = cuts.map((c) => String(c == null ? "" : c).trim());
    if (uppers.length !== count - 1) return { ok: false, error: `Give ${count - 1} split point${count - 1 === 1 ? "" : "s"} for ${count} batches` };
    if (uppers.some((c) => !c)) return { ok: false, error: "A split point cannot be empty" };
    for (let i = 1; i < uppers.length; i++) if (naturalCompare(uppers[i - 1], uppers[i]) >= 0) return { ok: false, error: "The split points must go up from the first batch to the last" };
  } else {
    if (sorted.length < count) return { ok: false, error: `Only ${sorted.length} student${sorted.length === 1 ? "" : "s"} with a roll number in this class, which is not enough for ${count} batches` };
    const base = Math.floor(sorted.length / count), extra = sorted.length % count;
    uppers = [];
    let idx = 0;
    for (let i = 0; i < count - 1; i++) { idx += base + (i < extra ? 1 : 0); uppers.push(sorted[idx - 1]); }
  }

  const batches = [];
  for (let i = 0; i < count; i++) {
    const after = i === 0 ? null : uppers[i - 1];
    const upto = i === count - 1 ? null : uppers[i];
    const spec = { batch_no: i + 1, batch_after: after, batch_upto: upto };
    batches.push({ batch_no: i + 1, name: `B${i + 1}`, after, upto, size: all.filter((r) => inBatch(spec, r)).length });
  }
  if (n > 0 && batches.some((b) => b.size === 0)) {
    const empty = batches.find((b) => b.size === 0);
    return { ok: false, error: `${empty.name} would have no students. Move the split point.` };
  }
  return { ok: true, batches };
}

module.exports = { naturalCompare, rollOf, inBatch, batchFields, planBatches };