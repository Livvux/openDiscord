/**
 * Shortens a file name in the middle so its extension always stays visible
 * ("invoice-….exe", never "invoice-………"), which defeats long-name extension spoofing.
 */
export function shortFilename(name: string, max = 48): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
  const head = Math.max(1, max - ext.length - 1);
  return `${name.slice(0, head)}…${ext}`;
}

/**
 * A safe display/download name: no paths, control or bidi characters, at most 128 characters.
 * Shared by community uploads (via `cleanFilename`) and decrypted DM attachments, which arrive undecoded.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .normalize("NFKC")
    .split(/[\\/]/)
    .pop()!
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    // Blank-looking characters (braille blank, ideographic space…) would hide a real extension.
    .replace(/[\p{Z}\u2800\u3164\uFFA0]+/gu, " ")
    .trim()
    .slice(-128);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}

/**
 * The upload header form: URI-decoded first. The name is only ever shown as text and sent in an
 * RFC 5987 `filename*`, never used on disk.
 */
export function cleanFilename(raw: string | null): string {
  let name = "file";
  try {
    name = decodeURIComponent(raw ?? "") || "file";
  } catch {
    // Malformed encoding: fall back to the generic name.
  }
  return sanitizeFilename(name);
}
