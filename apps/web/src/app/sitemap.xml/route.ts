import { connection } from "next/server";
import { escapeHtml, publicOrigin } from "@/server/public-html";

/** Bounded fresh discovery seed; the paginated directory links every active public channel. */
export async function GET() {
  await connection();
  const { listPublicChannels } = await import("@/server/public-channels");
  const { channels } = await listPublicChannels();
  const paths = ["/", "/discover", ...channels.map((ch) => `/public/${ch.id}`)];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>${escapeHtml(new URL(path, publicOrigin()).href)}</loc></url>`).join("")}</urlset>`, { headers: { "Content-Type": "application/xml", "Cache-Control": "private, no-store", "CDN-Cache-Control": "no-store" } });
}
