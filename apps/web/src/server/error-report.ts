import { randomUUID } from "node:crypto";
import { errorReportSchema, type ErrorReport } from "@/lib/error-report";

/** Small Sentry-envelope transport; no automatic request, user, breadcrumb or console capture. */
export async function reportError(input: ErrorReport): Promise<void> {
  const configured = process.env.GLITCHTIP_DSN;
  if (!configured) return;
  try {
    const report = errorReportSchema.parse(input);
    const dsn = new URL(configured);
    if (dsn.protocol !== "https:" || !/^[a-f0-9]{32}$/i.test(dsn.username) || !/^\/\d+$/.test(dsn.pathname) || dsn.password || dsn.search || dsn.hash) return;
    const eventId = randomUUID().replaceAll("-", "");
    const revision = process.env.OPENDISCORD_SOURCE_COMMIT;
    const event = JSON.stringify({
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: "javascript",
      level: "error",
      release: revision && /^[a-f0-9]{40}$/.test(revision) ? revision : "unverified",
      environment: process.env.NODE_ENV === "production" ? "production" : "development",
      tags: { source: report.source },
      exception: { values: [{ type: report.type, value: "Application error (private details omitted)",
        ...(report.frames.length ? { stacktrace: { frames: [...report.frames].reverse().map((frame) => ({ ...frame, in_app: true })) } } : {}),
      }] },
      fingerprint: [report.source, report.type, ...report.frames.slice(0, 1).map((frame) => `${frame.filename}:${frame.lineno}:${frame.colno}`)],
    });
    const endpoint = new URL(`/api${dsn.pathname}/envelope/`, dsn.origin);
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(3000),
      headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${dsn.username}` },
      body: `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event", length: Buffer.byteLength(event) })}\n${event}\n`,
    });
    await response.body?.cancel();
    if (!response.ok) console.warn("[error-report] delivery refused");
  } catch {
    console.warn("[error-report] delivery unavailable");
  }
}
