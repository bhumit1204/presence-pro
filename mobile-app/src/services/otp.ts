// src/services/otp.ts — e-mail OTP + forgot password (talks to routes/otp.routes.js)
import { API_BASE } from "./api";
import { fetchJson, normaliseEmail } from "../utils/validation";

export type OtpPurpose = "register" | "reset";

export class OtpError extends Error {
  status: number;
  resendIn?: number;
  constructor(message: string, status: number, resendIn?: number) {
    super(message);
    this.status = status;
    this.resendIn = resendIn;
  }
}

const post = async (path: string, body: object) => {
  const res = await fetchJson(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // No JSON error body means the request never reached our handler (route not mounted, proxy page, wrong URL)
    const fallback =
      res.status === 404
        ? `Server has no ${path} route (404). Mount routes/otp.routes.js and restart the backend.`
        : `Unexpected server response (${res.status}). Please try again.`;
    if (!res.data?.error) console.warn("OTP request failed:", path, res.status);
    throw new OtpError(res.data?.error || fallback, res.status, res.data?.resend_in);
  }
  return res.data || {};
};

/** Mails a 6-digit code. Returns seconds until another code may be requested. */
export async function sendOtp(email: string, purpose: OtpPurpose): Promise<number> {
  const d = await post("/auth/otp/send", { email: normaliseEmail(email), purpose });
  return Number(d.resend_in) || 60;
}

/** Checks the code. Returns a single-use token that registration / password reset require. */
export async function verifyOtp(email: string, purpose: OtpPurpose, otp: string): Promise<string> {
  const d = await post("/auth/otp/verify", { email: normaliseEmail(email), purpose, otp });
  if (!d.otp_token) throw new OtpError("Verification failed. Please try again.", 500);
  return String(d.otp_token);
}

export async function resetPassword(email: string, otpToken: string, newPassword: string): Promise<void> {
  await post("/auth/password/reset", { email: normaliseEmail(email), otp_token: otpToken, new_password: newPassword });
}