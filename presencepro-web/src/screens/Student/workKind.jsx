// @ts-nocheck
// Shared by the student assignment pages: what kind of work an item is (lecture, lab or tutorial).
import { Pill } from "./ui";

export const KINDS = [
  { key: "assignment",    label: "Lecture work",  short: "Lecture",  tone: "gray",   icon: "📝", stream: "New assignment" },
  { key: "lab_work",      label: "Lab work",      short: "Lab",      tone: "purple", icon: "🧪", stream: "New lab work" },
  { key: "tutorial_work", label: "Tutorial work", short: "Tutorial", tone: "blue",   icon: "🎓", stream: "New tutorial work" },
];

export const kindOf = (a) => KINDS.find((k) => k.key === a?.kind) || KINDS[0];

/** A small coloured label: Lecture / Lab / Tutorial. */
export function KindPill({ a, long = false }) {
  const k = kindOf(a);
  return <Pill tone={k.tone}>{long ? k.label : k.short}</Pill>;
}

/**
 * A row of filter chips (All / Lecture / Lab / Tutorial) that only shows when the list holds two or more kinds.
 * `value` is "all" or a kind key.
 */
export function KindFilter({ items, value, onChange }) {
  const counts = KINDS.map((k) => ({ ...k, n: items.filter((a) => kindOf(a).key === k.key).length }));
  if (counts.filter((k) => k.n > 0).length < 2) return null;
  return (
    <div className="st-chips">
      <button className={`st-chip${value === "all" ? " st-chip--active" : ""}`} onClick={() => onChange("all")}>All types</button>
      {counts.filter((k) => k.n > 0).map((k) => (
        <button key={k.key} className={`st-chip${value === k.key ? " st-chip--active" : ""}`} onClick={() => onChange(k.key)}>
          {k.icon} {k.short} <span style={{ opacity: 0.7 }}>{k.n}</span>
        </button>
      ))}
    </div>
  );
}

// ── Tags (topics): "CA Assignment", "Syllabus", ... made by the subject's teacher ──
export const tagName = (tags, id) => (id ? (tags || []).find((t) => t.tag_id === id)?.name || null : null);

/** A small label with the tag of an item (nothing when it has none). */
export function TagPill({ tags, id }) {
  const n = tagName(tags, id);
  return n ? <Pill tone="gray">🏷 {n}</Pill> : null;
}

/** "all" | "none" | a tag id */
export const applyTag = (items, sel) => (sel === "all" ? items : sel === "none" ? items.filter((x) => !x.tag_id) : items.filter((x) => x.tag_id === sel));

/** Chips: All / each tag in use / Other. Hidden when nothing is tagged. */
export function TagFilter({ tags, items, value, onChange }) {
  const known = new Set((tags || []).map((t) => t.tag_id));
  const used = (tags || []).filter((t) => items.some((x) => x.tag_id === t.tag_id));
  if (!used.length) return null;
  const rest = items.filter((x) => !x.tag_id || !known.has(x.tag_id)).length;
  return (
    <div className="st-chips">
      <button className={`st-chip${value === "all" ? " st-chip--active" : ""}`} onClick={() => onChange("all")}>All topics</button>
      {used.map((t) => (
        <button key={t.tag_id} className={`st-chip${value === t.tag_id ? " st-chip--active" : ""}`} onClick={() => onChange(t.tag_id)}>
          🏷 {t.name} <span style={{ opacity: 0.7 }}>{items.filter((x) => x.tag_id === t.tag_id).length}</span>
        </button>
      ))}
      {rest > 0 && <button className={`st-chip${value === "none" ? " st-chip--active" : ""}`} onClick={() => onChange("none")}>Other <span style={{ opacity: 0.7 }}>{rest}</span></button>}
    </div>
  );
}

/** [{ key, label, items }] in the teacher's tag order, untagged last. One unnamed group when nothing is tagged. */
export function groupByTag(items, tags) {
  const known = new Set((tags || []).map((t) => t.tag_id));
  if (!items.some((x) => x.tag_id && known.has(x.tag_id))) return [{ key: "all", label: "", items }];
  const out = (tags || []).map((t) => ({ key: t.tag_id, label: t.name, items: items.filter((x) => x.tag_id === t.tag_id) })).filter((g) => g.items.length);
  const rest = items.filter((x) => !x.tag_id || !known.has(x.tag_id));
  if (rest.length) out.push({ key: "none", label: "Other", items: rest });
  return out;
}
