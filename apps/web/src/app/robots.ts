import type { MetadataRoute } from "next";

/** Only marketing and explicitly public projections are indexable. */
export default function robots(): MetadataRoute.Robots {
  return { sitemap: new URL("/sitemap.xml", process.env.BETTER_AUTH_URL ?? "https://opendiscord.app").href, rules: { userAgent: "*", allow: "/", disallow: ["/app", "/api", "/invite"] } };
}
