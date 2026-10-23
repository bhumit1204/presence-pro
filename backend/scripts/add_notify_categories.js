#!/usr/bin/env node
/**
 * Optional: makes the "Other activities" switches in the app's Notifications screen work.
 * Tags the existing notify({...}) calls with a category (assignment / quiz / announcement) so a student who
 * switched that kind off no longer gets it. Safe to run twice; run it from the backend folder:
 *
 *     node scripts/add_notify_categories.js
 */
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const RULES = {
  "routes/assignment.routes.js": [[/New Announcement/, "announcement"], [/KIND_TITLE\[/, "assignment"], [/Assignment Graded/, "assignment"]],
  "routes/quiz.routes.js": [[/New Quiz/, "quiz"]],
  "routes/broadcast.routes.js": [[/./, "announcement"]],
};
for (const [rel, rules] of Object.entries(RULES)) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { console.log("skip (not found):", rel); continue; }
  let src = fs.readFileSync(file, "utf8"), out = "", i = 0, n = 0;
  for (;;) {
    const at = src.indexOf("notify({", i);
    if (at < 0) { out += src.slice(i); break; }
    // the end of this call: the matching "}" of the object
    let depth = 0, j = at + "notify(".length, end = -1;
    for (; j < src.length; j++) { if (src[j] === "{") depth++; else if (src[j] === "}") { depth--; if (depth === 0) { end = j; break; } } }
    const block = end > 0 ? src.slice(at, end + 1) : "";
    const rule = block && !/\bcategory\s*:/.test(block) ? rules.find(([re]) => re.test(block)) : null;
    if (rule) { out += src.slice(i, at) + `notify({ category: "${rule[1]}",` + src.slice(at + "notify({".length, end + 1); n++; }
    else out += src.slice(i, end > 0 ? end + 1 : at + 8);
    i = end > 0 ? end + 1 : at + 8;
  }
  if (n) fs.writeFileSync(file, out);
  console.log(`${rel}: ${n} call(s) tagged`);
}
