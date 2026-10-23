/**
 * utils/phone.js
 *
 * Indian mobile numbers. A valid number is exactly 10 digits, starts with 6-9 and is not one repeated digit.
 * It is stored as "+91XXXXXXXXXX". normalizePhone() accepts what people really type:
 * "98765 43210", "+91 98765-43210", "0098765 43210", "098765 43210" -> "+919876543210"; anything else -> null.
 */
function normalizePhone(value) {
  if (value === undefined || value === null) return null;
  let d = String(value).replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d) || /^(\d)\1{9}$/.test(d)) return null;
  return `+91${d}`;
}

const PHONE_ERROR = "Enter a valid 10 digit mobile number (starting with 6, 7, 8 or 9)";

module.exports = { normalizePhone, PHONE_ERROR };