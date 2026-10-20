/**
 * utils/upload.js
 *
 * Light content sniffing for user uploads. The original only trusted the
 * Content-Type header the client sent, so any file could be stored under an
 * allowed type. We now also check the first bytes of the file match the type.
 *
 * Set UPLOAD_SNIFF=off to disable (e.g. if a device produces unusual files).
 */

const SIGNATURES = {
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]], // %PDF
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47]],
  "image/gif": [[0x47, 0x49, 0x46, 0x38]], // GIF8
  "image/webp": [[0x52, 0x49, 0x46, 0x46]], // RIFF....WEBP (checked below)
  "application/msword": [[0xd0, 0xcf, 0x11, 0xe0]], // OLE2
  "application/vnd.ms-powerpoint": [[0xd0, 0xcf, 0x11, 0xe0]],
  "application/vnd.ms-excel": [[0xd0, 0xcf, 0x11, 0xe0]],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [[0x50, 0x4b, 0x03, 0x04]], // zip
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [[0x50, 0x4b, 0x03, 0x04]],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [[0x50, 0x4b, 0x03, 0x04]],
};

function looksLikeItsType(buffer, mimetype) {
  if (String(process.env.UPLOAD_SNIFF || "").toLowerCase() === "off") return true;
  if (!buffer || !buffer.length) return false;
  if (mimetype === "text/plain") {
    // plain text must not contain NUL bytes in the first 4 KB
    return !buffer.subarray(0, 4096).includes(0);
  }
  const sigs = SIGNATURES[mimetype];
  if (!sigs) return true; // type we have no signature for -> already restricted by the allow-list
  const ok = sigs.some((sig) => sig.every((b, i) => buffer[i] === b));
  if (!ok) return false;
  if (mimetype === "image/webp") return buffer.subarray(8, 12).toString("ascii") === "WEBP";
  return true;
}

module.exports = { looksLikeItsType };
