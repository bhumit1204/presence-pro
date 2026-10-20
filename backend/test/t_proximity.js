const { mk } = require("./lib/helpers");
const P = require("../new/utils/proximity");
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) passes++; else { fails++; console.log("  ✗", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// ── unit: engine
const T = [{ bssid: "aa:01", rssi: -50 }, { bssid: "aa:02", rssi: -60 }, { bssid: "aa:03", rssi: -65 }, { bssid: "aa:04", rssi: -72 }];
const same = T.map((x) => ({ ...x, rssi: x.rssi - 3 }));
const far = [{ bssid: "bb:01", rssi: -60 }, { bssid: "bb:02", rssi: -70 }, { bssid: "aa:04", rssi: -88 }];
const mid = [{ bssid: "aa:01", rssi: -75 }, { bssid: "aa:02", rssi: -85 }, { bssid: "bb:09", rssi: -70 }];
const v = (o) => P.evaluate({ teacherWifi: T, studentWifi: same, bleRssi: -60, bleTokens: [], secret: null, tokenActive: false, bleOff: false, ...o });
eq(v({}).verdict, "verified", "good/good");
eq(v({ studentWifi: mid }).verdict, "unverified", "ble good / wifi mid-or-bad -> unverified");
eq(v({ studentWifi: far }).verdict, "unverified", "ble good / wifi bad -> unverified");
eq(v({ bleRssi: -85 }).verdict, "unverified", "ble mid / wifi good -> unverified");
eq(v({ bleRssi: -95 }).verdict, "unverified", "ble bad / wifi good -> unverified");
eq(v({ bleRssi: null }).verdict, "unverified", "no ble / wifi good -> unverified");
eq(v({ bleRssi: -85, studentWifi: far }).verdict, "rejected", "ble mid / wifi bad -> rejected");
eq(v({ bleRssi: -95, studentWifi: far }).verdict, "rejected", "both bad");
eq(v({ bleRssi: null, studentWifi: [] }).verdict, "rejected", "nothing");
ok(v({ bleRssi: -95 }).reasons.includes("signals_disagree"), "reason signals_disagree");
eq(v({ bleOff: true }).verdict, "verified", "ble off + good wifi");
eq(v({ bleOff: true, studentWifi: mid }).verdict === "rejected" || v({ bleOff: true, studentWifi: mid }).verdict === "unverified", true, "ble off + mid wifi not verified");
eq(v({ bleOff: true, studentWifi: far }).verdict, "rejected", "ble off + far wifi");
// token
const sec = P.newSecret(); const now = Date.now(); const tok = P.currentToken(sec, now);
ok(P.verifyToken(sec, tok, now), "token ok now");
ok(P.verifyToken(sec, tok, now + 15000), "token ok +15s");
ok(!P.verifyToken(sec, tok, now + 60000), "token expired +60s");
ok(!P.verifyToken(sec, "deadbeef", now), "bad token");
ok(!P.verifyToken("other", tok, now), "other secret");
eq(v({ secret: sec, tokenActive: true, bleTokens: [tok] }).verdict, "verified", "token valid -> verified");
eq(v({ secret: sec, tokenActive: true, bleTokens: [] }).verdict, "unverified", "token missing -> degrades to unverified");
eq(v({ secret: sec, tokenActive: true, bleTokens: ["deadbeef"], studentWifi: far }).verdict, "rejected", "bad token + far wifi");
// teacher fingerprint unusable + token
eq(P.evaluate({ teacherWifi: [], studentWifi: same, bleRssi: -60, bleTokens: [tok], secret: sec, tokenActive: true, bleOff: false }).verdict, "verified", "wifi n/a + valid token");
eq(P.evaluate({ teacherWifi: [], studentWifi: same, bleRssi: -60, bleTokens: [], secret: sec, tokenActive: true, bleOff: false }).verdict, "unverified", "wifi n/a + no token");
// fingerprint
const sc = (rs) => T.map((x, i) => ({ ...x, rssi: x.rssi + rs[i] }));
const fp = P.buildFingerprint([sc([0, 0, 0, 0]), sc([2, -2, 0, 0]), [{ bssid: "aa:01", rssi: -50 }, { bssid: "zz:99", rssi: -50 }]]);
ok(fp.length === 4 && !fp.find((x) => x.bssid === "zz:99"), "fingerprint keeps only APs seen >=2 times");
// class reference
const cr = new P.ClassReference(); for (let i = 0; i < 5; i++) cr.add("S", same);
ok(cr.get("S") && cr.get("S").length === 4, "class ref after 5");
const cr2 = new P.ClassReference(); for (let i = 0; i < 4; i++) cr2.add("S", same); ok(cr2.get("S") === null, "class ref needs 5");

// ── routes
(async () => {
  const S = await mk("new", { seed: (d) => { for (const u of Object.keys(d.students)) d.students[u].course_name = "Bachelor of CA"; return d; } });
  const flush = () => S.routers["routes/lecture.routes.js"].flushPending();
  const post = (u, b) => S.q(u, "POST", "/api/lectures" + u, { body: b });
  const get = (u) => S.q(u, "GET", "/api/lectures" + u);
  const st = await post("/start", { lecture_id: "L1_Monday", teacher_id: "T1", subject_name: "Data Structures", room: "R1", aishe_code: "C-1", scheduled_start_time: "09:00", scheduled_end_time: "10:00" });
  const LS = st.body.session_id;
  const a = await post("/attendance/start", { lecture_session_id: LS, marking_method: "multi", teacher_wifi_scan: [sc([0, 0, 0, 0]), sc([1, 1, 0, 0]), sc([0, -1, 0, 0])], ble_service_uuid: "ble-x" });
  const AS = a.body.attendance_session_id;
  ok(a.body.success && /^\d{3}$/.test(a.body.attendance_code), "multi start creates a code");
  const doc = S.db.dump("attendance_sessions")[AS];
  const sec1 = S.db.dump("attendance_secrets")[AS];
  ok(sec1 && sec1.ble_secret && doc.teacher_wifi_scan.length === 4 && doc.marking_method === "multi" && !("ble_secret" in doc), "secret in server-only collection, fingerprint on session");
  const CODE = a.body.attendance_code;

  // token endpoint
  const tk = await get(`/attendance/ble-token?lecture_session_id=${LS}`);
  ok(tk.body.enabled && tk.body.token.length === 8 && tk.body.ble_service_uuid === "ble-x", "ble-token served");
  const tk2 = await get(`/attendance/ble-token?lecture_session_id=${LS}`);
  eq(tk2.body.token, tk.body.token, "token stable inside slot (or rotated exactly once)");
  const TOKEN = tk2.body.token;
  const m = (uid, o) => ({ attendance_session_id: AS, uid, ...o });

  // mark-code: verified (good wifi, good ble, token)
  let r = await post("/attendance/mark-code", m("s1", { selected_code: CODE, student_wifi_scan: same, ble_rssi: -60, ble_tokens: [TOKEN] }));
  ok(r.body.success && r.body.verification === "verified", "s1 verified via code");
  // wrong code
  r = await post("/attendance/mark-code", m("s2", { selected_code: "000", student_wifi_scan: same, ble_rssi: -60, ble_tokens: [TOKEN] }));
  ok(!r.body.success && r.body.error_type === "wrong_code", "wrong code");
  // ble weak but wifi good -> unverified/pending
  r = await post("/attendance/mark-code", m("s2", { selected_code: CODE, student_wifi_scan: same, ble_rssi: -92, ble_tokens: [] }));
  ok(r.body.success && r.body.pending && r.body.verification === "unverified", "s2 pending");
  // far from class -> rejected, no record
  r = await post("/attendance/mark-code", m("s3", { selected_code: CODE, student_wifi_scan: far, ble_rssi: -95, ble_tokens: [] }));
  ok(!r.body.success && r.body.verification === "rejected", "s3 rejected");
  // bio path in multi
  r = await post("/attendance/mark-bio", m("s4", { device_signature: "d1", student_wifi_scan: same, ble_rssi: -62, ble_tokens: [TOKEN] }));
  ok(r.body.success && r.body.verification === "verified", "s4 verified via bio");
  // replayed fake token (no token) with good rssi -> not verified
  r = await post("/attendance/mark-bio", m("s5", { device_signature: "d2", student_wifi_scan: same, ble_rssi: -55, ble_tokens: ["00000000"] }));
  ok(r.body.success && r.body.verification === "unverified", "s5 bad token -> unverified");
  await flush();
  const recs = S.db.dump("attendance_records");
  const rec = (u) => recs[`${AS}_${u}`];
  eq(rec("s1").status, "present", "s1 record present"); eq(rec("s1").method, "multi_code", "s1 method");
  eq(rec("s2").status, "pending", "s2 record pending"); ok(rec("s2").reasons.length > 0 && rec("s2").signals, "s2 reasons+signals stored");
  ok(!rec("s3"), "s3 nothing stored");
  eq(rec("s4").method, "multi_bio", "s4 method");
  const attDoc = S.db.dump("attendance_sessions")[AS];
  eq([...attDoc.present_students].sort(), ["s1", "s4"], "present_students excludes pending");
  eq([...attDoc.pending_students].sort(), ["s2", "s5"], "pending_students");

  // teacher sees pending first
  const vs = await get(`/attendance/verify-students?attendance_session_id=${AS}&lecture_session_id=${LS}`);
  const list = vs.body.students;
  ok(list[0].status === "pending" && list[1].status === "pending", "pending listed first");
  ok(list.find((x) => x.uid === "s2").reasons.length > 0, "reasons exposed to teacher");
  ok(!list.find((x) => x.uid === "s2").is_present, "pending not counted present");

  // pending student re-marks closer -> upgrade
  r = await post("/attendance/mark-code", m("s2", { selected_code: CODE, student_wifi_scan: same, ble_rssi: -58, ble_tokens: [TOKEN] }));
  ok(r.body.success && r.body.verification === "verified", "s2 upgraded");
  await flush();
  const att2 = S.db.dump("attendance_sessions")[AS];
  ok(att2.present_students.includes("s2") && !att2.pending_students.includes("s2"), "s2 moved pending -> present");

  // teacher confirms s5, rejects nobody else; verify-attendance with ticked = s1,s2,s4,s5
  r = await post("/attendance/verify-attendance", { attendance_session_id: AS, lecture_session_id: LS, verified_students: ["s1", "s2", "s4", "s5"] });
  ok(r.body.success, "verify-attendance ok");
  await flush();
  eq(S.db.dump("attendance_records")[`${AS}_s5`].status, "present", "s5 confirmed by teacher");
  eq(S.db.dump("attendance_records")[`${AS}_s5`].verification, "teacher_confirmed", "s5 verification label");
  ok(S.db.dump("attendance_sessions")[AS].present_students.includes("s5") && !S.db.dump("attendance_sessions")[AS].pending_students.includes("s5"), "s5 moved to present");

  // teacher-decided absent cannot be overwritten by student
  r = await post("/attendance/verify-attendance", { attendance_session_id: AS, lecture_session_id: LS, verified_students: ["s1", "s2", "s4"] });
  r = await post("/attendance/mark-code", m("s5", { selected_code: CODE, student_wifi_scan: same, ble_rssi: -58, ble_tokens: [TOKEN] }));
  ok(!r.body.success && r.body.error_type === "reviewed", "student can't overwrite teacher decision");

  // ── method locks
  const st2 = await post("/start", { lecture_id: "L1_Monday", teacher_id: "T1", subject_name: "Data Structures", room: "R1", aishe_code: "C-1", scheduled_start_time: "09:00", scheduled_end_time: "10:00" });
  const LSb = st2.body.session_id;
  const b = await post("/attendance/start", { lecture_session_id: LSb, marking_method: "code", teacher_wifi_scan: sc([0, 0, 0, 0]), ble_service_uuid: "ble-x" });
  const ASb = b.body.attendance_session_id;
  r = await post("/attendance/mark-bio", { attendance_session_id: ASb, uid: "s1", student_wifi_scan: same, ble_rssi: -50 });
  ok(!r.body.success && r.body.error_type === "method_disabled", "mark-bio blocked on code session");
  // code session now has a proximity check: far student rejected
  r = await post("/attendance/mark-code", { attendance_session_id: ASb, uid: "s1", selected_code: b.body.attendance_code, student_wifi_scan: far, ble_rssi: -97 });
  ok(!r.body.success, "code session now enforces proximity");
  await post("/attendance/close", { lecture_session_id: LSb });
  const closed = S.db.dump("attendance_sessions")[ASb];
  ok(!S.db.dump("attendance_secrets")[ASb] && !closed.attendance_code, "secret + code removed on close");

  // teacher does not advertise (no ble uuid) -> wifi only
  const st3 = await post("/start", { lecture_id: "L1_Monday", teacher_id: "T1", subject_name: "Data Structures", room: "R1", aishe_code: "C-1", scheduled_start_time: "09:00", scheduled_end_time: "10:00" });
  const c = await post("/attendance/start", { lecture_session_id: st3.body.session_id, marking_method: "bio_wifi_ble", teacher_wifi_scan: sc([0, 0, 0, 0]) });
  r = await post("/attendance/mark-bio", { attendance_session_id: c.body.attendance_session_id, uid: "s6", device_signature: "q1", student_wifi_scan: same });
  ok(r.body.success && r.body.verification === "verified", "ble off: good wifi verified");
  r = await post("/attendance/mark-bio", { attendance_session_id: c.body.attendance_session_id, uid: "s7", device_signature: "q2", student_wifi_scan: far });
  ok(!r.body.success, "ble off: far wifi rejected");

  // pending isn't counted in reports data: only status present is "present"
  console.log(`\nproximity tests: ${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
