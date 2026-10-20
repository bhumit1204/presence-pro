// src/services/headApi.js
//
// Client for the Head-of-Department API (/api/web/head/*).
// Every call sends a FRESH Firebase ID token — the one stored at login expires
// after ~1 hour — and turns backend errors into Error objects whose message is
// the server's own text, so pages can show it directly.
//
//   const { courses } = await headApi.get("/context");
//   await headApi.put(`/semesters/${courseId}/1`, { start_date, end_date });
//
// Thrown errors carry: err.status (HTTP code) and err.data (full JSON body,
// e.g. err.data.conflicts for a 409 timetable clash).

import { auth } from "./firebase";
import { getSessionToken } from "./session";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
const BASE = `${API}/api/web/head`;

async function freshToken() {
  try {
    // Wait for Firebase to restore the signed-in user after a page reload
    if (typeof auth.authStateReady === "function") await auth.authStateReady();
    if (auth.currentUser) return await auth.currentUser.getIdToken();
  } catch {
    /* fall through to the stored token */
  }
  return getSessionToken();
}

async function request(method, path, body) {
  const token = await freshToken();
  if (!token) {
    throw Object.assign(new Error("Your session has expired. Please sign in again."), { status: 401 });
  }

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error("Can't reach the server. Check your connection and try again."), { status: 0 });
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }

  if (!res.ok) {
    const message =
      (data && (data.error || data.message)) ||
      (res.status === 401 ? "Your session has expired. Please sign in again." : `Request failed (${res.status})`);
    throw Object.assign(new Error(message), { status: res.status, data });
  }
  return data;
}

export const headApi = {
  get:  (path)       => request("GET", path),
  post: (path, body) => request("POST", path, body ?? {}),
  put:  (path, body) => request("PUT", path, body ?? {}),
  del:  (path)       => request("DELETE", path),
};

export default headApi;