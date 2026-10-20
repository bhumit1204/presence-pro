// src/services/refreshSession.js
//
// Keeps the stored session in sync with the database so changes made while a
// user is logged in (head assigned/removed in the institute app, account
// deactivated) show up without logging out and in again.
//
//   useSessionRefresh()  — mount once in ProtectedRoute: refreshes on mount,
//                          every minute, and when the tab regains focus.
//   useSessionVersion()  — mount in any component that reads the session
//                          (e.g. AppSidebar) so it re-renders when it changes.

import { useEffect, useState } from "react";
import { auth } from "./firebase";
import {
  SESSION_EVENT,
  getSessionToken,
  getSessionUser,
  updateSession,
  clearUserSession,
} from "./session";

const API_URL = import.meta.env.VITE_API_URL || "";
const REFRESH_EVERY_MS = 60 * 1000;

let inFlight = null;

export function refreshSession() {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      if (!getSessionUser()) return;

      // Prefer a fresh Firebase token (stored one expires after ~1h).
      let token = getSessionToken();
      try {
        if (auth.currentUser) token = await auth.currentUser.getIdToken();
      } catch {
        /* fall back to stored token */
      }
      if (!token) return;

      const res = await fetch(`${API_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      // Account deactivated → end the session; ProtectedRoute sends to login.
      if (res.status === 403) {
        clearUserSession();
        window.dispatchEvent(new Event(SESSION_EVENT));
        return;
      }
      // Network/expired token/etc: keep what we have, try again next tick.
      if (!res.ok) return;

      const data = await res.json();
      updateSession({ user: data.user, profile: data.profile, token });
    } catch {
      /* offline or server down — keep the current session */
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Re-renders the caller whenever the stored session changes. */
export function useSessionVersion() {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(SESSION_EVENT, bump);
    window.addEventListener("storage", bump); // other tabs
    return () => {
      window.removeEventListener(SESSION_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);

  return version;
}

/** Polls /auth/me (mount, interval, tab focus) and returns the version. */
export function useSessionRefresh(intervalMs = REFRESH_EVERY_MS) {
  const version = useSessionVersion();

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshSession();
    };

    refreshSession();
    const id = setInterval(refreshSession, intervalMs);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);

  return version;
}