import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/limits", () => ({ consume: vi.fn() }));
vi.mock("@/server/error-report", () => ({ reportError: vi.fn() }));
import { POST } from "@/app/api/error-report/route";
import { reportError } from "@/server/error-report";
import { AppError } from "@/server/errors";
import { consume } from "@/server/limits";

const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const body = { source: "browser-error", type: "TypeError", frames: [] };
function request(data: unknown = body, origin: string | null = new URL(base).origin) {
  return new Request(`${base}/api/error-report`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(data) });
}

describe("bounded error-report ingestion", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("GLITCHTIP_DSN", `https://${"a".repeat(32)}@errors.test/3`); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([null, "https://foreign.invalid"])("refuses origin %s before reading or acquiring a quota", async (origin) => {
    const req = request(body, origin);
    expect((await POST(req)).status).toBe(403);
    expect(req.bodyUsed).toBe(false);
    expect(consume).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("requires JSON and rejects server sources and arbitrary private fields", async () => {
    const req = request(); req.headers.set("content-type", "text/plain");
    expect((await POST(req)).status).toBe(400);
    expect((await POST(request({ ...body, source: "server-route" }))).status).toBe(400);
    expect((await POST(request({ ...body, message: "private message" }))).status).toBe(400);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("enforces the shared limit before reading and caps actual body bytes", async () => {
    vi.mocked(consume).mockRejectedValueOnce(new AppError("rate_limited", "Wait."));
    const req = request();
    expect((await POST(req)).status).toBe(429);
    expect(req.bodyUsed).toBe(false);
    expect((await POST(request({ ...body, extra: "a".repeat(4096) }))).status).toBe(400);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("forwards only validated browser diagnostics with a non-cacheable empty response", async () => {
    const response = await POST(request());
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(reportError).toHaveBeenCalledExactlyOnceWith(body);
    expect(consume).toHaveBeenCalledWith("error-report:browser", 60, 60_000);
  });

  it("does not read reports or touch the database when reporting is disabled", async () => {
    vi.stubEnv("GLITCHTIP_DSN", "");
    const req = request();
    expect((await POST(req)).status).toBe(204);
    expect(req.bodyUsed).toBe(false);
    expect(consume).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});
