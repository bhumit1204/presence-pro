// ============================================================
// KEEP IN: INSTITUTE BACKEND
// PATH:    utils/autoApprove.js  (NEW file - create a 'utils' folder next to server.js)
// ============================================================
"use strict";
/**
 * Auto-approve by e-mail domain: one place for the rules, shared by
 *   - settings.routes.js   (saving the list)
 *   - institute.routes.js  (the "Run auto-approve" button)
 *   - server.js            (start-up sync)
 *
 * The student app registers against the WORKING database, but the institute's
 * settings live in the INSTITUTE database. So every time the settings change we
 * also write a small private copy into the working DB:
 *
 *     college_settings/{aishe_code} = { auto_approve_enabled, auto_approve_domains }
 *
 * The main backend reads that doc while a student registers. It is a separate
 * collection on purpose: colleges/{id} is returned by a public endpoint, and the
 * trusted-domain list should not be.
 */
const { FieldValue } = require("firebase-admin/firestore");

const SETTINGS_COLLECTION = "college_settings";
const MAX_DOMAINS = 20;

// Anyone can open an account on these, so trusting them would approve everybody.
const PUBLIC_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.in", "yahoo.co.in", "ymail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "proton.me", "protonmail.com", "pm.me", "zoho.com", "zohomail.in", "gmx.com",
  "mail.com", "rediffmail.com", "yandex.com", "tutanota.com", "fastmail.com",
]);

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

const normalizeDomain = (d) =>
  String(d == null ? "" : d).trim().toLowerCase().replace(/^@+/, "").replace(/\.+$/, "");

/** -> { domains: string[] } or { error: string } */
function cleanDomains(list) {
  if (!Array.isArray(list)) return { error: "auto_approve_domains must be an array." };
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") return { error: "Every domain must be text." };
    const d = normalizeDomain(raw);
    if (!d) continue;
    if (!DOMAIN_RE.test(d)) return { error: `Invalid domain: ${raw.slice(0, 80)}` };
    if (PUBLIC_MAIL.has(d)) {
      return { error: `${d} is a public e-mail provider - anyone can sign up with it, so it cannot be trusted.` };
    }
    if (!out.includes(d)) out.push(d);
  }
  if (out.length > MAX_DOMAINS) return { error: `At most ${MAX_DOMAINS} domains are allowed.` };
  return { domains: out };
}

/** "Name@Dept.College.edu" -> "dept.college.edu"; "" when it is not a single clean address. */
function emailDomain(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1 || at !== e.lastIndexOf("@")) return "";
  return e.slice(at + 1);
}

/** Exact domain match (a sub-domain must be listed on its own). */
function emailMatches(email, domains) {
  const d = emailDomain(email);
  return !!d && Array.isArray(domains) && domains.includes(d);
}

const settingsDocId = (aishe) =>
  typeof aishe === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(aishe) ? aishe : null;

/** Copy the institute's auto-approve settings into the working DB. Returns true when written. */
async function mirrorSettings(workingDb, aishe_code, enabled, domains) {
  const id = settingsDocId(aishe_code);
  if (!id) return false;
  await workingDb.collection(SETTINGS_COLLECTION).doc(id).set(
    {
      aishe_code,
      auto_approve_enabled: !!enabled,
      auto_approve_domains: Array.isArray(domains) ? domains : [],
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return true;
}

/** Start-up self-heal: institutes configured before the mirror existed are copied across once. */
async function syncAllMirrors({ instituteDb, workingDb, COLLECTIONS }) {
  const snap = await instituteDb.collection(COLLECTIONS.INSTITUTES).where("auto_approve_enabled", "==", true).get();
  let n = 0;
  for (const doc of snap.docs) {
    const i = doc.data();
    const c = cleanDomains(i.auto_approve_domains || []);
    if (c.error) continue;
    if (await mirrorSettings(workingDb, i.aishe_code, true, c.domains)) n++;
  }
  return n;
}

module.exports = {
  SETTINGS_COLLECTION, MAX_DOMAINS, PUBLIC_MAIL,
  normalizeDomain, cleanDomains, emailDomain, emailMatches, mirrorSettings, syncAllMirrors,
};