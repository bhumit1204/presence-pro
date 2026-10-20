// src/services/studentApi.js
//
// API client for the student portal. Reuses the mobile endpoints and the
// /api/web/student/* aggregates.
//   • every call sends a FRESH Firebase ID token (the stored one expires after ~1h)
//   • 401  -> refresh the token once and retry
//   • 429 / 503 (rate-limited / busy) -> wait for Retry-After and retry (max 2x)
//   • errors are Error objects whose message is the server's own text (err.status, err.data)
//   • serverNow() is the server's clock (from the Date header) - used by the test timer
//
//   const { quizzes } = await studentApi.quizzes();

import { auth } from "./firebase";
import { getSessionToken, getSessionUser } from "./session";

export const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

// ── server clock ─────────────────────────────────────────────────────
let skew = 0;
export const serverNow = () => Date.now() + skew;
function noteServerTime(res) {
  const d = res.headers.get("Date");
  const t = d ? Date.parse(d) : NaN;
  if (Number.isFinite(t)) skew = t - Date.now();
}

// ── identity ─────────────────────────────────────────────────────────
export function myUid() {
  return auth.currentUser?.uid || getSessionUser()?.uid || null;
}

async function freshToken(force = false) {
  try {
    if (typeof auth.authStateReady === "function") await auth.authStateReady();
    if (auth.currentUser) return await auth.currentUser.getIdToken(force);
  } catch {
    /* fall back to the stored token */
  }
  return getSessionToken();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, path, { body, form, query } = {}) {
  let url = `${API}${path}`;
  if (query) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && qs.set(k, v));
    const s = qs.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }

  let token = await freshToken();
  if (!token) throw Object.assign(new Error("Your session has expired. Please sign in again."), { status: 401 });

  let refreshed = false;
  let busy = 0;

  for (;;) {
    const headers = { Authorization: `Bearer ${token}` };
    let payload;
    if (form) payload = form; // browser sets the multipart boundary itself
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, { method, headers, body: payload });
    } catch {
      throw Object.assign(new Error("Can't reach the server. Check your connection and try again."), { status: 0 });
    }
    noteServerTime(res);

    if (res.status === 401 && !refreshed) {
      refreshed = true;
      const fresh = await freshToken(true);
      if (fresh && fresh !== token) {
        token = fresh;
        continue;
      }
    }
    if ((res.status === 429 || res.status === 503) && busy < 2) {
      busy++;
      const ra = Number(res.headers.get("Retry-After"));
      await sleep(Math.min(4000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 600 * busy) + Math.random() * 250);
      continue;
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON */
    }

    if (!res.ok) {
      const message =
        (data && (data.message || data.error)) ||
        (res.status === 401 ? "Your session has expired. Please sign in again."
          : res.status === 429 ? "Too many requests — please wait a moment and try again."
          : res.status === 503 ? "The server is busy right now — please try again in a moment."
          : `Request failed (${res.status})`);
      throw Object.assign(new Error(message), { status: res.status, data });
    }
    return data;
  }
}

const get = (p, query) => request("GET", p, { query });
const post = (p, body) => request("POST", p, { body: body ?? {} });
const put = (p, body) => request("PUT", p, { body: body ?? {} });
const del = (p, body) => request("DELETE", p, { body });

// ── endpoints ────────────────────────────────────────────────────────
export const studentApi = {
  // aggregates (routes/web/student.routes.js)
  feed:       () => get("/api/web/student/feed", { uid: myUid() }),
  subjects:   () => get("/api/web/student/subjects", { uid: myUid() }),

  // profile
  profile: () => get(`/api/profile/student/${myUid()}`),


  // tests
  quizzes:    () => get(`/api/quizzes/student-quizzes/${myUid()}`),
  joinQuiz:   ({ quiz_id, code }) =>
    code ? get(`/api/quizzes/join/${encodeURIComponent(code)}`) : get(`/api/quizzes/join-open/${quiz_id}`),
  submitQuiz: (quiz_id, answers) => post("/api/quizzes/submit", { quiz_id, student_uid: myUid(), answers }),
  quizResult: (quiz_id) => get(`/api/quizzes/${quiz_id}/result`, { student_uid: myUid() }),

  // assignments
  mySubmission: (assignment_id) => get(`/api/assignments/${assignment_id}/my-submission`, { student_uid: myUid() }),
  uploadFiles: (files, entity_id) => {
    const form = new FormData();
    form.append("folder", "submissions");
    if (entity_id) form.append("entity_id", entity_id);
    files.forEach((f) => form.append("files", f, f.name));
    return request("POST", "/api/assignments/upload", { form });
  },
  submitAssignment: (id, { attachments, links }) =>
    post(`/api/assignments/${id}/submit`, { student_uid: myUid(), attachments, links }),
  resubmitAssignment: (id, { attachments, links, deleted_keys }) =>
    put(`/api/assignments/${id}/resubmit`, { student_uid: myUid(), attachments, links, deleted_keys }),
  unsubmitAssignment: (id) => post(`/api/assignments/${id}/unsubmit`, { student_uid: myUid() }),

  // broadcasts (teacher → students)
  broadcasts:    () => get(`/api/broadcasts/student/${myUid()}`),
  markBroadcast: (id) => post(`/api/broadcasts/${id}/read`, { uid: myUid() }),
};

export default studentApi;
