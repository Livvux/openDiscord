const BASE = "http://same-origin.invalid";

/**
 * Only same-origin paths. Parses like a browser would, so "//evil", "/\\evil" and control-character
 * tricks such as "/\t/evil" (browsers strip tabs and newlines) are rejected.
 */
export function safeNextPath(value: string | null | undefined, fallback = "/app"): string {
  if (!value || !value.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  try {
    const url = new URL(value, BASE);
    return url.origin === BASE ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch {
    return fallback;
  }
}
