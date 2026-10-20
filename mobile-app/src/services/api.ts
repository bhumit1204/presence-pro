// src/services/api.ts
// Drop-in replacement for fetch() that talks to the PresencePro backend.
//   • attaches  Authorization: Bearer <fresh Firebase ID token>  (token is refreshed by
//     Firebase automatically; we never use the one stored in the session for requests)
//   • on 401 -> force-refreshes the token and retries once
//   • on 429 / 503 (rate-limited / server busy) -> waits for Retry-After and retries (max 2x)
//   • FormData bodies are passed through untouched (no Content-Type forced)
// Signature is identical to fetch(url, init) so call sites only change the function name.

import { auth } from "./firebase";

export const API_BASE =
  process.env.EXPO_PUBLIC_API_URL || "https://presencepro.duckdns.org";

const MAX_BUSY_RETRIES = 2;
const MAX_WAIT_MS = 4000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getToken(force = false): Promise<string | null> {
  try {
    const u = auth.currentUser;
    if (!u) return null;
    return await u.getIdToken(force);
  } catch {
    return null;
  }
}

function withAuth(init: RequestInit | undefined, token: string | null): RequestInit {
  const headers: Record<string, string> = {};
  const src: any = init?.headers;
  if (src) {
    if (typeof src.forEach === "function" && !Array.isArray(src)) {
      src.forEach((v: string, k: string) => (headers[k] = v));
    } else if (Array.isArray(src)) {
      src.forEach(([k, v]: [string, string]) => (headers[k] = v));
    } else {
      Object.assign(headers, src);
    }
  }
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
  if (token && !hasAuth) headers["Authorization"] = `Bearer ${token}`;
  return { ...(init || {}), headers };
}

export async function apiFetch(input: any, init?: RequestInit): Promise<Response> {
  let token = await getToken();
  let refreshed = false;
  let busyTries = 0;

  for (;;) {
    const res = await fetch(input, withAuth(init, token));

    if (res.status === 401 && !refreshed && auth.currentUser) {
      refreshed = true;
      const fresh = await getToken(true);
      if (fresh && fresh !== token) {
        token = fresh;
        continue;
      }
      return res;
    }

    if ((res.status === 429 || res.status === 503) && busyTries < MAX_BUSY_RETRIES) {
      busyTries++;
      const ra = Number(res.headers.get("Retry-After"));
      const wait = Math.min(
        MAX_WAIT_MS,
        Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * busyTries
      );
      await sleep(wait + Math.random() * 250);
      continue;
    }

    return res;
  }
}
