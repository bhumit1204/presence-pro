// src/utils/phone.ts
// Indian mobile numbers: the app shows a fixed +91 prefix and the user types the 10 digits after it.
// A valid number is exactly 10 digits and starts with 6, 7, 8 or 9. It is stored and sent as "+91XXXXXXXXXX".
// The server applies the same rule (backend utils/phone.js), this file only makes the form friendly.

export const PHONE_PREFIX = "+91";

/**
 * Cleans what the user typed or pasted into the 10 digits after +91.
 * Letters, spaces and dashes are dropped; a pasted "+91 98765 43210", "0098765…" or "098765…" becomes the
 * bare 10 digits. `prev` is the value before this change, so typing an 11th digit is simply ignored
 * (it is not mistaken for a pasted country code).
 */
export function sanitizePhoneInput(raw: string, prev = ""): string {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length <= 10) return d;
  if (prev.length >= 10 && d.length === prev.length + 1 && d.startsWith(prev)) return prev.slice(0, 10); // typed one digit too many
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length > 10 && d.startsWith("91")) d = d.slice(2);
  else if (d.length > 10 && d.startsWith("0")) d = d.slice(1);
  return d.slice(0, 10);
}

/** 10 digits, first digit 6-9, not the same digit repeated (9999999999) */
export function isValidPhone(p: string): boolean {
  const d = String(p || "");
  return /^[6-9]\d{9}$/.test(d) && !/^(\d)\1{9}$/.test(d);
}

/** the message to show under the field, or null when the number is fine */
export function phoneError(p: string): string | null {
  const d = String(p || "").replace(/\D/g, "");
  if (!d) return "Enter your mobile number";
  if (d.length < 10) return `A mobile number has 10 digits (you entered ${d.length})`;
  if (!/^[6-9]/.test(d)) return "A mobile number starts with 6, 7, 8 or 9";
  if (!isValidPhone(d)) return "Enter a valid mobile number";
  return null;
}

/** "+91XXXXXXXXXX" for a valid number, otherwise null */
export function toIntlPhone(p: string): string | null {
  const d = sanitizePhoneInput(p);
  return isValidPhone(d) ? `${PHONE_PREFIX}${d}` : null;
}

/** a stored number for display: "+91 98765 43210". Anything that is not a recognisable mobile number is shown as stored. */
export function formatPhone(stored?: string | null): string {
  const raw = String(stored ?? "").trim();
  if (!raw || raw === "null" || raw === "undefined") return "";
  const d = sanitizePhoneInput(raw);
  return isValidPhone(d) ? `${PHONE_PREFIX} ${d.slice(0, 5)} ${d.slice(5)}` : raw;
}