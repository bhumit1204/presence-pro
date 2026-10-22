// utils/assignmentState.js
// An assignment is a draft, scheduled for later, or posted. Documents written before this
// existed have no `status`, so they count as posted. A scheduled post becomes visible the
// moment its publish_at passes: nobody has to wait for the background job that sends the
// notification.

const KINDS = ["assignment", "lab_work", "tutorial_work"];   // lecture work | lab work | tutorial work
const KIND_LABEL = { assignment: "Assignment", lab_work: "Lab work", tutorial_work: "Tutorial work" };

function toMs(v) {
  if (!v) return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.toDate === "function") return v.toDate().getTime();
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/** "draft" | "scheduled" | "published" */
function stateOf(d, now = Date.now()) {
  const s = d && d.status;
  if (s === "draft") return "draft";
  if (s === "scheduled") {
    const t = toMs(d.publish_at);
    return t != null && t > now ? "scheduled" : "published";
  }
  return "published";
}

const isLive = (d, now = Date.now()) => stateOf(d, now) === "published";
const kindOf = (d) => (d && KINDS.includes(d.kind) ? d.kind : "assignment");

module.exports = { KINDS, KIND_LABEL, toMs, stateOf, isLive, kindOf };
