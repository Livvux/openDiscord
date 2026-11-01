import { afterEach, describe, expect, it, vi } from "vitest";
import { errorReportSchema } from "@/lib/error-report";
import { sanitizedError } from "@/lib/error-report-client";
import { reportError } from "@/server/error-report";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("private error diagnostics", () => {
  it("omits messages, private page paths, queries, third-party URLs and arbitrary error names", () => {
    const error = new TypeError("secret message and recovery key");
    error.stack = ["TypeError: secret", "at fn (https://local.test/_next/static/chunks/main.js:10:20)",
      "at fn (https://local.test/app/messages?recovery=secret:10:20)",
      "at fn (https://elsewhere.test/_next/static/secret.js:10:20)",
      "at fn (https://local.test/_next/static/main.js?token=secret:10:20)"].join("\n");
    const report = sanitizedError(error, "browser-error", "https://local.test");
    expect(report).toEqual({ source: "browser-error", type: "TypeError", frames: [{ filename: "/_next/static/chunks/main.js", lineno: 10, colno: 20 }] });
    expect(JSON.stringify(report)).not.toMatch(/secret|recovery|token|elsewhere|messages/);
    error.name = "private-account-name";
    expect(sanitizedError(error, "server-route")).toEqual({ source: "server-route", type: "Error", frames: [] });
    expect(sanitizedError({ message: "secret" }, "browser-rejection").type).toBe("Error");
  });

  it("rejects extra private fields, raw page paths and unbounded frames", () => {
    const report = { source: "browser-error", type: "Error", frames: [] };
    expect(errorReportSchema.safeParse({ ...report, message: "private" }).success).toBe(false);
    expect(errorReportSchema.safeParse({ ...report, frames: [{ filename: "/app/messages", lineno: 1, colno: 1 }] }).success).toBe(false);
    expect(errorReportSchema.safeParse({ ...report, frames: Array(13).fill({ filename: "/_next/static/main.js", lineno: 1, colno: 1 }) }).success).toBe(false);
  });

  it("retains the first Firefox and WebKit frame without an Error header", () => {
    const error = new Error("private");
    error.stack = "fn@https://local.test/_next/static/chunks/main.js:10:20\n@https://local.test/_next/static/chunks/other.js:30:40";
    expect(sanitizedError(error, "browser-error", "https://local.test").frames).toHaveLength(2);
  });

  it("does not send diagnostics without a configured destination", async () => {
    vi.stubEnv("GLITCHTIP_DSN", "");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await reportError({ source: "server-render", type: "Error", frames: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("submits an exact-revision envelope without browser credentials or request context", async () => {
    vi.stubEnv("GLITCHTIP_DSN", `https://${"a".repeat(32)}@errors.test/3`);
    vi.stubEnv("OPENDISCORD_SOURCE_COMMIT", "b".repeat(40));
    const fetcher = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetcher);
    await reportError({ source: "server-route", type: "TypeError", frames: [] });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://errors.test/api/3/envelope/");
    expect(options).toMatchObject({ credentials: "omit", redirect: "error", method: "POST" });
    const [header, item, body] = String(options.body).split("\n");
    const event = JSON.parse(body);
    expect(JSON.parse(item)).toMatchObject({ type: "event", length: Buffer.byteLength(body) });
    expect(JSON.parse(header).event_id).toBe(event.event_id);
    expect(event.release).toBe("b".repeat(40));
    expect(event).not.toHaveProperty("request");
    expect(event).not.toHaveProperty("user");
    expect(event).not.toHaveProperty("breadcrumbs");
  });

  it("ignores malformed destinations and contains delivery failures", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("private provider details")); vi.stubGlobal("fetch", fetcher);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const dsn of ["not-a-url", "https://key@errors.test/3", `http://${"a".repeat(32)}@errors.test/3`]) {
      vi.stubEnv("GLITCHTIP_DSN", dsn);
      await reportError({ source: "server-route", type: "Error", frames: [] });
    }
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubEnv("GLITCHTIP_DSN", `https://${"a".repeat(32)}@errors.test/3`);
    await reportError({ source: "server-route", type: "Error", frames: [] });
    expect(warn).toHaveBeenLastCalledWith("[error-report] delivery unavailable");
  });
});
