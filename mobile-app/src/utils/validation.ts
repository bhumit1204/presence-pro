// src/utils/validation.ts
// Input validation + safe networking helpers shared by the login and registration screens.
// Client-side checks are for good UX and to avoid sending junk; the server must still enforce every rule.

/* ───────────── email / password ───────────── */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const normaliseEmail = (e: string) => e.trim().toLowerCase();
export const isValidEmail = (e: string) => e.length <= 254 && EMAIL_RE.test(e);

// Same rule the registration screens used before: 8+ chars, upper, lower, digit and one of @$!%*?&
export const PASSWORD_SPECIALS = "@$!%*?&";
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,64}$/;

export function passwordChecks(pw: string): { ok: boolean; label: string }[] {
  return [
    { ok: pw.length >= 8, label: "8+ characters" },
    { ok: /[a-z]/.test(pw), label: "Lowercase" },
    { ok: /[A-Z]/.test(pw), label: "Uppercase" },
    { ok: /\d/.test(pw), label: "Number" },
    { ok: /[@$!%*?&]/.test(pw), label: `Special (${PASSWORD_SPECIALS})` },
  ];
}

/** Returns a message when the password is not acceptable, otherwise null. */
export function validatePassword(pw: string): string | null {
  if (PASSWORD_RE.test(pw)) return null;
  if (pw.length > 64) return "Password is too long (max 64 characters).";
  if (/[^A-Za-z\d@$!%*?&]/.test(pw)) return `Use only letters, numbers and these symbols: ${PASSWORD_SPECIALS}`;
  return `Use 8+ characters with an uppercase letter, a lowercase letter, a number and one of ${PASSWORD_SPECIALS}`;
}

/* ───────────── profile fields ───────────── */

/** Collapse whitespace, strip control characters, cap the length. */
export function cleanText(s: string, max = 60): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

export const isValidName = (s: string) => /^[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F .'\-]{0,49}$/.test(s);

/** Digits only, optional leading +, 10 to 13 digits. Returns the cleaned number or null. */
export function cleanPhone(raw: string): string | null {
  const v = raw.replace(/[\s\-().]/g, "");
  return /^\+?\d{10,13}$/.test(v) ? v : null;
}

export const cleanRoll = (s: string) => s.replace(/[^A-Za-z0-9\-_/]/g, "").slice(0, 30);

/** AISHE codes look like C-12345 / U-0123. Keep to a safe alphabet before it goes into a URL. */
export function cleanAishe(raw: string): string | null {
  const v = raw.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9\-]{2,19}$/.test(v) ? v : null;
}

/* ───────────── auth error messages ───────────── */

/**
 * Turns Firebase / server errors into messages that never reveal whether an e-mail exists.
 * `credential` is true when the failure counts towards the login lockout.
 */
export function friendlyAuthError(e: any): { message: string; credential: boolean } {
  const code: string = e?.code || "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-login-credentials":
      return { message: "Incorrect email or password.", credential: true };
    case "auth/invalid-email":
      return { message: "That email address does not look right.", credential: false };
    case "auth/user-disabled":
      return { message: "This account is disabled. Contact your institute administrator.", credential: false };
    case "auth/too-many-requests":
      return { message: "Too many attempts. Wait a few minutes or reset your password.", credential: false };
    case "auth/network-request-failed":
      return { message: "No connection. Check your internet and try again.", credential: false };
    default:
      if (code.startsWith("auth/")) return { message: "Could not sign you in. Please try again.", credential: false };
      return { message: e?.message || "Something went wrong. Please try again.", credential: false };
  }
}

/* ───────────── networking ───────────── */

export interface JsonResult {
  ok: boolean;
  status: number;
  data: any;
}

/**
 * fetch + timeout + safe JSON parsing. Never throws on a non-JSON body; throws a readable Error on
 * timeout / network failure.
 */
export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<JsonResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("The server took too long to answer. Please try again.");
    throw new Error("Could not reach the server. Check your connection.");
  } finally {
    clearTimeout(timer);
  }
}

export const isAlreadyRegistered = (r: JsonResult) =>
  r.status === 409 || /already|exists|registered|in use/i.test(String(r.data?.error || r.data?.message || ""));