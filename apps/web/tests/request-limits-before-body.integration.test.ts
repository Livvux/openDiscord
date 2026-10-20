// Expensive routes apply their rate limit before reading (or parsing) the request body.
import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/server/account", () => ({ exportUserData: vi.fn(async () => ({ exportedAt: new Date().toISOString() })) }));
vi.mock("@/server/direct-messages", () => ({ saveDmBackup: vi.fn(), handleCryptoRequest: vi.fn(async () => ({})), deleteDmBackup: vi.fn(), getDmBackup: vi.fn(), listDmBackups: vi.fn() }));
import { GET as exportMe } from "@/app/api/me/export/route";
import { POST as saveBackup } from "@/app/api/dm/backups/route";
import { POST as crypto } from "@/app/api/dm/crypto/route";
import { exportUserData } from "@/server/account";
import { handleCryptoRequest, saveDmBackup } from "@/server/direct-messages";
import { requireUser } from "@/server/session";

const origin = new URL(process.env.BETTER_AUTH_URL ?? "https://local.invalid").origin;
const dmRequest = (path: string) => new Request(`${origin}${path}`, {
  method: "POST", body: "{}",
  headers: { origin, "content-type": "application/json", "x-dm-device": randomUUID(), "x-dm-device-secret": randomBytes(32).toString("hex") },
});

beforeEach(() => {
  vi.clearAllMocks();
  // A fresh account per test, so the shared rate-limit table starts empty for it.
  const id = randomUUID();
  vi.mocked(requireUser).mockResolvedValue({ id, sessionId: randomUUID() } as never);
});

describe("rate limits before the request body", () => {
  it("limits personal data exports to three per hour", async () => {
    for (let i = 0; i < 3; i++) expect((await exportMe(new Request(`${origin}/api/me/export`))).status).toBe(200);
    expect((await exportMe(new Request(`${origin}/api/me/export`))).status).toBe(429);
    expect(exportUserData).toHaveBeenCalledTimes(3);
  });
  it("refuses an over-limit encrypted backup without reading its body", async () => {
    for (let i = 0; i < 10; i++) expect((await saveBackup(dmRequest("/api/dm/backups"))).status).toBe(200);
    const refused = dmRequest("/api/dm/backups");
    expect((await saveBackup(refused)).status).toBe(429);
    expect(refused.bodyUsed).toBe(false);
    expect(saveDmBackup).toHaveBeenCalledTimes(10);
  });
  it("refuses an over-limit crypto request without reading its body", async () => {
    for (let i = 0; i < 240; i++) expect((await crypto(dmRequest("/api/dm/crypto"))).status).toBe(200);
    const refused = dmRequest("/api/dm/crypto");
    expect((await crypto(refused)).status).toBe(429);
    expect(refused.bodyUsed).toBe(false);
    expect(handleCryptoRequest).toHaveBeenCalledTimes(240);
  }, 30_000);
});
