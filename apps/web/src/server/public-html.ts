import { PRIVATE_NO_STORE } from "./http";

export const publicOrigin = () => new URL(process.env.BETTER_AUTH_URL ?? "https://opendiscord.app").origin;
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** No script, prefetch, cookies or private app providers on the anonymous surface. */
export function publicHtml(title: string, body: string, path: string, status = 200) {
  const canonical = new URL(path, publicOrigin()).href;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · openDiscord</title><meta name="description" content="Explicitly public text channels on openDiscord.">${status === 404 ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${escapeHtml(canonical)}">`}<style>
    :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#111114;color:#f4f4f5}*{box-sizing:border-box}body{margin:0}a{color:#b8b8ff;text-underline-offset:3px}a:hover{color:white}a:focus-visible,button:focus-visible,textarea:focus-visible{outline:3px solid #a5a5ff;outline-offset:4px}header,main{max-width:840px;margin:auto;padding:24px}nav{display:flex;gap:24px;flex-wrap:wrap}header{border-bottom:1px solid #333}h1{font-size:clamp(1.7rem,5vw,2.5rem);overflow-wrap:anywhere}h2{font-size:1.1rem}p{line-height:1.6}.muted,time{color:#b5b5bf;font-size:.875rem}.notice{padding:16px;border:1px solid #555;border-radius:8px}ul,ol{list-style:none;padding:0}li{padding:20px 0;border-bottom:1px solid #333}article p{white-space:pre-wrap;overflow-wrap:anywhere}article h2{display:inline;margin-right:12px}textarea{display:block;width:100%;min-height:130px;background:#222;color:white;border:1px solid #888;border-radius:6px;margin:12px 0;padding:12px;font:inherit}button{background:#b8b8ff;color:#111;border:0;border-radius:6px;padding:12px 20px;font:inherit;cursor:pointer}.pagination{display:block;margin:24px 0}footer{margin-top:32px}.report{font-size:.8rem}label{display:block}strong{font-weight:650}
  </style></head><body><header><nav aria-label="Main navigation"><a href="/">openDiscord</a><a href="/discover">Discover public channels</a><a href="/app">Open app</a></nav></header><main>${body}</main></body></html>`, {
    status, headers: { ...PRIVATE_NO_STORE, "Content-Type": "text/html; charset=utf-8", "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store" },
  });
}
export const publicNotFound = () => publicHtml("Not found", "<h1>Not found</h1><p>This public content is unavailable.</p>", "/discover", 404);
