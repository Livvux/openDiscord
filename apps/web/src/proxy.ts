// Sets the Content-Security-Policy per request. Everything is restricted to this origin except:
// - Cloudflare Turnstile on sign-up (allowed app-wide: client-side navigation keeps the CSP of the
//   page it started from);
// - the operator's LiveKit server for voice, known only from runtime settings.
// Inline scripts are Next.js bootstrap code; a nonce-based CSP would force every page dynamic.
import { NextResponse } from "next/server";

const dev = process.env.NODE_ENV !== "production";
const TURNSTILE = "https://challenges.cloudflare.com";

function liveKitOrigins(): string {
  const raw = process.env.LIVEKIT_URL;
  if (!raw) return "";
  try {
    const { host, protocol } = new URL(raw);
    const secure = protocol === "wss:" || protocol === "https:";
    // Signalling uses WebSockets; the client also calls the HTTP validate endpoint on failures.
    return ` ${secure ? "wss" : "ws"}://${host} ${secure ? "https" : "http"}://${host}`;
  } catch {
    return "";
  }
}

export const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""} ${TURNSTILE}`,
  `frame-src 'self' ${TURNSTILE}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${liveKitOrigins()}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function proxy() {
  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", CSP);
  return response;
}

export const config = {
  // Static build assets don't need a policy; attachments set their own stricter one (`sandbox`).
  matcher: ["/((?!_next/static|_next/image|api/attachments/).*)"],
};
