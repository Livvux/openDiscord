import { describe, expect, it } from "vitest";
import robots from "@/app/robots";

describe("marketing crawler access", () => {
  it("lets search crawlers inherit public access while retaining private-route exclusions", () => {
    const result = robots();
    expect(result.rules).toEqual({ userAgent: "*", allow: "/", disallow: ["/app", "/api", "/invite"] });
    expect(result.sitemap).toMatch(/\/sitemap\.xml$/);
  });
});
