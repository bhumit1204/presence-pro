/**
 * utils/proximity.js
 *
 * "Is this student really in the classroom?" - Wi-Fi fingerprint + BLE (+ rotating BLE token).
 *
 * Result is a 3-state verdict instead of a score:
 *   verified   -> counted as present immediately
 *   unverified -> stored as `pending`, NOT counted until the teacher confirms
 *   rejected   -> nothing is stored, the student is told why
 *
 * Every threshold lives in CONFIG so it can be tuned from real classes (signals are stored on the record).
 */

const crypto = require("crypto");

const CONFIG = {
  // BLE: median RSSI (dBm) of the teacher beacon over the student's scan window
  BLE_GOOD: -80, // >= good
  BLE_MID: -90, //  >= mid, below = bad

  // Wi-Fi similarity (0..1)
  WIFI_GOOD: 0.55,
  WIFI_MID: 0.3,
  WIFI_MIN_SHARED_FOR_GOOD: 2,

  // BLE switched off on the teacher side -> Wi-Fi alone decides
  WIFI_ONLY_VERIFIED: 0.7,
  WIFI_ONLY_UNVERIFIED: 0.55,

  // per-AP credit
  AP_FULL_DELTA: 10, // |dRSSI| <= 10 dB -> full credit
  AP_ZERO_DELTA: 25, //  >= 25 dB -> no credit
  RSSI_BEST: -40,
  RSSI_WORST: -90,
  STRONG_FOREIGN_RSSI: -65, // student hears this AP strongly but teacher does not hear it at all
  FOREIGN_PENALTY_EACH: 0.1,
  FOREIGN_PENALTY_MAX: 0.3,
  STALE_WIFI_FACTOR: 0.9,

  // teacher fingerprint build
  FP_MIN_SEEN: 2, // AP must appear in >= 2 of the 3 scans
  FP_MAX_APS: 20,
  FP_MIN_RSSI: -85,

  // class reference (median of already-verified students)
  CLASS_REF_MIN_STUDENTS: 5,
  CLASS_REF_MAX_STUDENTS: 60,

  // BLE rotating token
  TOKEN_SLOT_MS: 10_000,
  TOKEN_BACK: 2,
  TOKEN_FWD: 1,
  TOKEN_HEX: 8,
  TOKEN_ACTIVE_MS: 90_000, // teacher polled within this -> token mode
};

/* ───────────────────────── token ───────────────────────── */

const newSecret = () => crypto.randomBytes(16).toString("hex");
const slotOf = (now) => Math.floor(now / CONFIG.TOKEN_SLOT_MS);
const tokenForSlot = (secret, slot) =>
  crypto.createHmac("sha256", String(secret)).update(String(slot)).digest("hex").slice(0, CONFIG.TOKEN_HEX);
const currentToken = (secret, now = Date.now()) => tokenForSlot(secret, slotOf(now));

function verifyToken(secret, token, now = Date.now()) {
  if (!secret || typeof token !== "string" || token.length !== CONFIG.TOKEN_HEX) return false;
  const t = token.toLowerCase();
  const s = slotOf(now);
  for (let i = s - CONFIG.TOKEN_BACK; i <= s + CONFIG.TOKEN_FWD; i++) if (tokenForSlot(secret, i) === t) return true;
  return false;
}

/* ───────────────────────── small math ───────────────────────── */

const median = (arr) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const norm = (rssi) => {
  const c = Math.max(CONFIG.RSSI_WORST, Math.min(CONFIG.RSSI_BEST, rssi));
  return (c - CONFIG.RSSI_WORST) / (CONFIG.RSSI_BEST - CONFIG.RSSI_WORST);
};

const lc = (b) => (typeof b === "string" ? b.toLowerCase() : "");
const num = (v) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/* ───────────────────────── teacher fingerprint ───────────────────────── */

/**
 * scans: array of scans (each [{ssid,bssid,rssi}]). A single flat scan is accepted too.
 * Keeps APs seen in >= FP_MIN_SEEN scans (or all, when only one scan was given), RSSI averaged.
 */
function buildFingerprint(scans) {
  if (!Array.isArray(scans) || scans.length === 0) return [];
  const list = Array.isArray(scans[0]) ? scans : [scans];
  const need = list.length >= 2 ? Math.min(CONFIG.FP_MIN_SEEN, list.length) : 1;
  const acc = new Map();
  for (const scan of list) {
    if (!Array.isArray(scan)) continue;
    const seenHere = new Set();
    for (const n of scan) {
      const b = lc(n?.bssid);
      const r = num(n?.rssi);
      if (!b || r === null || seenHere.has(b)) continue;
      seenHere.add(b);
      const e = acc.get(b) || { bssid: b, ssid: n.ssid ?? null, sum: 0, n: 0 };
      e.sum += r;
      e.n += 1;
      acc.set(b, e);
    }
  }
  return [...acc.values()]
    .filter((e) => e.n >= need)
    .map((e) => ({ bssid: e.bssid, ssid: e.ssid, rssi: Math.round(e.sum / e.n) }))
    .filter((e) => e.rssi >= CONFIG.FP_MIN_RSSI)
    .sort((a, b) => b.rssi - a.rssi)
    .slice(0, CONFIG.FP_MAX_APS);
}

/* ───────────────────────── wifi similarity ───────────────────────── */

/** -> { score:0..1, shared:number, foreign:number } */
function wifiSimilarity(reference, studentScan) {
  const ref = (reference || []).filter((n) => lc(n.bssid) && num(n.rssi) !== null);
  const stu = new Map();
  for (const n of studentScan || []) {
    const b = lc(n.bssid);
    const r = num(n.rssi);
    if (b && r !== null) stu.set(b, Math.max(r, stu.get(b) ?? -200));
  }
  if (!ref.length || !stu.size) return { score: 0, shared: 0, foreign: 0 };

  let wSum = 0;
  let cSum = 0;
  let shared = 0;
  const refSet = new Set();
  for (const n of ref) {
    const b = lc(n.bssid);
    refSet.add(b);
    const w = norm(Number(n.rssi)) + 0.05;
    wSum += w;
    if (stu.has(b)) {
      shared++;
      const d = Math.abs(Number(n.rssi) - stu.get(b));
      const credit = d <= CONFIG.AP_FULL_DELTA ? 1 : d >= CONFIG.AP_ZERO_DELTA ? 0 : 1 - (d - CONFIG.AP_FULL_DELTA) / (CONFIG.AP_ZERO_DELTA - CONFIG.AP_FULL_DELTA);
      cSum += w * credit;
    }
  }
  let foreign = 0;
  for (const [b, r] of stu) if (!refSet.has(b) && r >= CONFIG.STRONG_FOREIGN_RSSI) foreign++;
  const penalty = Math.min(CONFIG.FOREIGN_PENALTY_MAX, foreign * CONFIG.FOREIGN_PENALTY_EACH);
  const score = wSum > 0 ? Math.max(0, cSum / wSum - penalty) : 0;
  return { score, shared, foreign };
}

/* ───────────────────────── class reference ───────────────────────── */

class ClassReference {
  constructor() {
    this.m = new Map(); // sid -> { n, aps: Map<bssid, number[]>, touched }
  }
  add(sid, scan) {
    if (!sid || !Array.isArray(scan) || !scan.length) return;
    let e = this.m.get(sid);
    if (!e) this.m.set(sid, (e = { n: 0, aps: new Map(), touched: Date.now() }));
    if (e.n >= CONFIG.CLASS_REF_MAX_STUDENTS) return;
    e.n++;
    e.touched = Date.now();
    for (const x of scan) {
      const b = lc(x.bssid);
      const r = num(x.rssi);
      if (!b || r === null) continue;
      const a = e.aps.get(b) || [];
      a.push(r);
      e.aps.set(b, a);
    }
  }
  /** median fingerprint once enough verified students exist, else null */
  get(sid) {
    const e = this.m.get(sid);
    if (!e || e.n < CONFIG.CLASS_REF_MIN_STUDENTS) return null;
    const need = Math.ceil(e.n / 2);
    const out = [];
    for (const [b, a] of e.aps) if (a.length >= need) out.push({ bssid: b, rssi: Math.round(median(a)) });
    return out.length >= 2 ? out : null;
  }
  drop(sid) {
    this.m.delete(sid);
  }
  sweep(maxAgeMs = 6 * 3600_000) {
    const cut = Date.now() - maxAgeMs;
    for (const [k, v] of this.m) if (v.touched < cut) this.m.delete(k);
  }
}

/* ───────────────────────── verdict ───────────────────────── */

const bleLevelOf = (rssi) => {
  if (rssi === null) return "none";
  if (rssi >= CONFIG.BLE_GOOD) return "good";
  if (rssi >= CONFIG.BLE_MID) return "mid";
  return "bad";
};
const wifiLevelOf = (score, shared) =>
  score >= CONFIG.WIFI_GOOD && shared >= CONFIG.WIFI_MIN_SHARED_FOR_GOOD ? "good" : score >= CONFIG.WIFI_MID ? "mid" : "bad";

// rows: ble level, cols: wifi level.  V verified / U unverified / R rejected
const MATRIX = {
  good: { good: "V", mid: "U", bad: "U", na: "T" }, // T = verified only with a valid token
  mid: { good: "U", mid: "U", bad: "R", na: "U" },
  bad: { good: "U", mid: "R", bad: "R", na: "R" },
};
const VERDICT = { V: "verified", U: "unverified", R: "rejected" };

/**
 * @param {object} p
 *  teacherWifi  [{bssid,rssi}]   stored teacher fingerprint
 *  classWifi    [{bssid,rssi}]|null  class reference (optional)
 *  studentWifi  [{bssid,rssi}]
 *  wifiFresh    boolean|null     false = the OS handed back an old scan
 *  bleRssi      number|null      median RSSI of the teacher beacon
 *  bleTokens    string[]         tokens the student heard
 *  secret       string|null
 *  tokenActive  boolean          teacher is polling tokens right now
 *  bleOff       boolean          teacher is not advertising at all
 */
function evaluate(p) {
  const now = p.now || Date.now();
  const reasons = [];

  // ---- wifi
  const studentWifi = Array.isArray(p.studentWifi) ? p.studentWifi : [];
  const tFp = (p.teacherWifi || []).filter((n) => n && lc(n.bssid) && num(n.rssi) !== null);
  const tUsable = tFp.length >= 2;
  let wifiScore = 0;
  let shared = 0;
  let foreign = 0;
  let wifiLevel = "na";
  if (studentWifi.length && tUsable) {
    const a = wifiSimilarity(tFp, studentWifi);
    let best = a;
    if (p.classWifi && p.classWifi.length >= 2) {
      const b = wifiSimilarity(p.classWifi, studentWifi);
      if (b.score > a.score) best = b;
    }
    wifiScore = best.score;
    shared = best.shared;
    foreign = best.foreign;
    if (p.wifiFresh === false) {
      wifiScore *= CONFIG.STALE_WIFI_FACTOR;
      reasons.push("wifi_stale");
    }
    wifiLevel = wifiLevelOf(wifiScore, shared);
  } else if (!studentWifi.length && tUsable) {
    reasons.push("wifi_unavailable");
  }

  // ---- ble
  const tokens = Array.isArray(p.bleTokens) ? p.bleTokens.slice(0, 40) : [];
  const tokenOk = !!p.secret && tokens.some((t) => verifyToken(p.secret, t, now));
  let bleRssi = num(p.bleRssi);
  let bleLevel = bleLevelOf(bleRssi);
  if (p.tokenActive && bleRssi !== null && !tokenOk) {
    // heard something that looks like the beacon but without a valid token -> replay / stale -> one step worse
    bleLevel = bleLevel === "good" ? "mid" : bleLevel === "mid" ? "bad" : bleLevel;
    reasons.push("ble_token_invalid");
  }

  const signals = {
    ble_rssi: bleRssi,
    ble_level: bleLevel,
    wifi_score: Math.round(wifiScore * 100) / 100,
    wifi_level: wifiLevel,
    wifi_shared: shared,
    wifi_foreign: foreign,
    token_ok: tokenOk,
    token_active: !!p.tokenActive,
    ble_off: !!p.bleOff,
  };

  const out = (code, errorType, message) => {
    const verdict = VERDICT[code];
    if (verdict === "unverified") {
      if (bleLevel === "none") reasons.push("ble_missing");
      else if (bleLevel === "mid" || bleLevel === "bad") reasons.push("ble_weak");
      if (wifiLevel === "mid" || wifiLevel === "bad") reasons.push("wifi_weak");
      if (wifiLevel === "na" && !reasons.includes("wifi_unavailable")) reasons.push("wifi_unavailable");
      if (bleLevel === "good" && wifiLevel !== "good" && wifiLevel !== "na") reasons.push("signals_disagree");
      if ((bleLevel === "mid" || bleLevel === "bad" || bleLevel === "none") && wifiLevel === "good") reasons.push("signals_disagree");
    }
    return { verdict, reasons: [...new Set(reasons)], signals, error_type: errorType, message };
  };

  // ---- BLE switched off -> wifi alone
  if (p.bleOff) {
    if (!studentWifi.length) return out("R", "no_signal", "No Wi-Fi scan available. Turn Wi-Fi and Location ON and try again.");
    if (!tUsable) return out("U", "no_reference", "Your teacher will confirm your presence.");
    if (wifiScore >= CONFIG.WIFI_ONLY_VERIFIED) return out("V", "none", "Proximity confirmed.");
    if (wifiScore >= CONFIG.WIFI_ONLY_UNVERIFIED) return out("U", "weak_wifi", "Your teacher will confirm your presence.");
    return out("R", "too_far", "Your Wi-Fi surroundings do not match the classroom. Move into the classroom and try again.");
  }

  // ---- normal path
  if (bleLevel === "none" && !studentWifi.length) {
    return out("R", "no_signal", "No signal detected. Make sure Wi-Fi, Bluetooth and Location are ON and try again.");
  }
  const row = MATRIX[bleLevel === "none" ? "bad" : bleLevel];
  let cell = row[wifiLevel];
  if (cell === "T") cell = !p.tokenActive || tokenOk ? "V" : "U";

  if (cell === "V") return out("V", "none", "Proximity confirmed.");
  if (cell === "U") return out("U", "unverified", "Your signals look weak or inconsistent. Your teacher will confirm your presence.");
  const msg =
    bleLevel === "none"
      ? "Teacher's Bluetooth beacon not found and your Wi-Fi surroundings do not match the classroom. Move closer to the teacher."
      : "Signal too weak to confirm you are in the room. Move closer to the teacher and try again.";
  return out("R", "too_far", msg);
}

module.exports = {
  CONFIG,
  newSecret,
  currentToken,
  verifyToken,
  buildFingerprint,
  wifiSimilarity,
  ClassReference,
  evaluate,
  median,
};
