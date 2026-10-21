// src/utils/batches.ts
// Lab batches. A division's lab can be split into 2 or 3 batches by ROLL NUMBER. Every batch is a lecture
// (and later a lecture session) that carries its own roll range:
//   batch: "B2", batch_no: 2, batch_of: 3, batch_after: "2330" (exclusive, null for the first batch),
//   batch_upto: "2360" (inclusive, null for the last batch).
// naturalCompare / rollOf / inBatch are COPIES of backend utils/batches.js and must stay identical,
// so the phone decides exactly like the server does.

/** "MCA9" < "MCA10", "2301" < "2310", case-insensitive; digits compared as numbers of any length */
export function naturalCompare(a: any, b: any): number {
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

/** a student document's roll number (registration stores roll_no; some older documents roll_number) */
export function rollOf(s: any): string {
  if (!s) return "";
  const v = s.roll_no != null ? s.roll_no : s.roll_number;
  return v == null ? "" : String(v).trim();
}

/** does a lecture / session carrying batch fields include this roll number? (no batch fields = everybody) */
export function inBatch(spec: any, roll: any): boolean {
  if (!spec || !spec.batch_no) return true;
  const r = String(roll == null ? "" : roll).trim();
  const after = spec.batch_after == null ? null : spec.batch_after;
  const upto = spec.batch_upto == null ? null : spec.batch_upto;
  if (!r) return upto === null;                       // no roll number: counted in the LAST batch
  if (after !== null && naturalCompare(r, after) <= 0) return false;
  if (upto !== null && naturalCompare(r, upto) > 0) return false;
  return true;
}

/** is this lecture / session meant for the student? (their division AND their lab batch) */
export function meantForStudent(spec: any, divisionId: string | null | undefined, roll: any): boolean {
  if (spec && spec.division_id && spec.division_id !== (divisionId || null)) return false;
  return inBatch(spec, roll);
}

const KIND_LABEL: Record<string, string> = { lab: "Lab", tutorial: "Tutorial" };

/** "Lab · B1" / "Tutorial" / "B2" / "" (plain lecture). withDivision adds "Div A" for teachers. */
export function lectureTag(l: any, withDivision = false): string {
  if (!l) return "";
  const parts: string[] = [];
  if (l.kind && KIND_LABEL[l.kind]) parts.push(KIND_LABEL[l.kind]);
  if (l.batch_no) parts.push(l.batch || `B${l.batch_no}`);
  if (withDivision && l.division_name) parts.push(`Div ${l.division_name}`);
  return parts.join(" · ");
}

/** a copy whose subject_name carries the tag, for components that only print subject_name (AttendanceCard, ...) */
export function withTag<T extends { subject_name?: string }>(l: T | null | undefined, withDivision = false): T | null {
  if (!l) return null;
  const tag = lectureTag(l, withDivision);
  const name = l.subject_name || "";
  if (!tag || name.endsWith(`(${tag})`)) return l;
  return { ...l, subject_name: `${name} (${tag})` };
}