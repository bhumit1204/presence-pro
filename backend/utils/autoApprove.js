"use strict";
/**
 * Auto-approve a student at registration when their (OTP-verified) e-mail is on a
 * domain the institute trusts.
 *
 * The institute portal copies its settings into  college_settings/{aishe_code}
 * ({ auto_approve_enabled, auto_approve_domains }) every time they are saved, so
 * this backend never needs access to the institute database.
 *
 * Fail-closed: anything unexpected (no doc, bad data, read error) -> not approved,
 * the student simply waits in the normal pending queue.
 */
const { db } = require("../config/firebase");
const { TTLCache } = require("./cache");

const cache = new TTLCache({ max: 500, ttlMs: 30_000 });

const emailDomain = (email) => {
  const e = String(email || "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1 || at !== e.lastIndexOf("@")) return "";
  return e.slice(at + 1);
};

async function loadSettings(aishe) {
  if (typeof aishe !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(aishe)) return null;
  return cache.memo(`aa:${aishe}`, 30_000, async () => {
    const doc = await db.collection("college_settings").doc(aishe).get();
    if (!doc.exists) return { enabled: false, domains: [] };
    const d = doc.data();
    return {
      enabled: d.auto_approve_enabled === true,
      domains: Array.isArray(d.auto_approve_domains) ? d.auto_approve_domains.map((x) => String(x).toLowerCase()) : [],
    };
  });
}

/** `emailVerified` must be true: the address was proven by OTP, so the domain claim is real. */
async function shouldAutoApprove(aishe, email, emailVerified) {
  if (!emailVerified) return false;
  try {
    const s = await loadSettings(String(aishe));
    if (!s || !s.enabled || s.domains.length === 0) return false;
    const d = emailDomain(email);
    return !!d && s.domains.includes(d);
  } catch (e) {
    console.error("auto-approve check failed (student stays pending):", e.message);
    return false;
  }
}

module.exports = { shouldAutoApprove, emailDomain };