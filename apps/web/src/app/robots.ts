import type { MetadataRoute } from "next";

/** Only the marketing site is public. Communities, invites and the API are never indexed. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: ["/app", "/api", "/invite"] } };
}
