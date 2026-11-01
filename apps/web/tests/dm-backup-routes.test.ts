import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/server/limits", () => ({ consume: vi.fn() }));
vi.mock("@/server/direct-messages", () => ({ deleteDmBackup: vi.fn(), getDmBackup: vi.fn(), listDmBackups: vi.fn(), saveDmBackup: vi.fn() }));

import { DELETE, GET, POST } from "@/app/api/dm/backups/route";
import { deleteDmBackup, getDmBackup, listDmBackups, saveDmBackup } from "@/server/direct-messages";
import { AppError } from "@/server/errors";
import { consume } from "@/server/limits";
import { requireUser } from "@/server/session";

const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const id = randomUUID();
const deviceId = randomUUID();
const secret = "a".repeat(64);
const user = { id: "backup-owner", sessionId: "backup-session", name: "Backup owner", email: "backup@example.test" };
function mutation(method: string, body: unknown, origin = new URL(base).origin) {
  return new Request(`${base}/api/dm/backups`, { method, headers: { origin, "content-type": "application/json", "x-dm-device": deviceId, "x-dm-device-secret": secret }, body: JSON.stringify(body) });
}

describe("encrypted DM recovery routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireUser).mockResolvedValue(user);
  });

  it("lists only the authenticated owner's metadata and retrieves ciphertext without caching", async () => {
    vi.mocked(listDmBackups).mockResolvedValue([{ id, createdAt: new Date(0) }]);
    const list = await GET(new Request(`${base}/api/dm/backups`));
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    expect(await list.json()).toEqual({ backups: [{ id, createdAt: new Date(0).toISOString() }] });
    expect(listDmBackups).toHaveBeenCalledWith(user.id);
    vi.mocked(getDmBackup).mockResolvedValue({ ciphertext: "encrypted" });
    const item = await GET(new Request(`${base}/api/dm/backups?id=${id}`));
    expect(await item.json()).toEqual({ ciphertext: "encrypted" });
    expect(getDmBackup).toHaveBeenCalledWith(user.id, id);
  });

  it("keeps create and delete responses compatible with the JSON recovery client", async () => {
    const body = { id, ciphertext: "a".repeat(128) };
    const created = await POST(mutation("POST", body));
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({});
    expect(saveDmBackup).toHaveBeenCalledWith({ userId: user.id, sessionId: user.sessionId, deviceId, secret }, body);
    const removed = await DELETE(mutation("DELETE", { id }));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({});
    expect(deleteDmBackup).toHaveBeenCalledWith(user.id, id);
  });

  it("rejects foreign origins before reading or authenticating mutation bodies", async () => {
    for (const handler of [POST, DELETE]) {
      const request = mutation(handler === POST ? "POST" : "DELETE", { id }, "https://foreign.invalid");
      expect((await handler(request)).status).toBe(403);
      expect(request.bodyUsed).toBe(false);
    }
    expect(requireUser).not.toHaveBeenCalled();
  });

  it("requires a session to read and device credentials to create recovery ciphertext", async () => {
    vi.mocked(requireUser).mockRejectedValueOnce(new AppError("unauthorized", "Sign in."));
    expect((await GET(new Request(`${base}/api/dm/backups`))).status).toBe(401);
    const request = mutation("POST", { id, ciphertext: "encrypted" });
    request.headers.delete("x-dm-device-secret");
    expect((await POST(request)).status).toBe(400);
    expect(saveDmBackup).not.toHaveBeenCalled();
  });

  it("applies the write rate limit before reading potentially large ciphertext", async () => {
    vi.mocked(consume).mockRejectedValueOnce(new AppError("rate_limited", "Wait."));
    const request = mutation("POST", { id, ciphertext: "encrypted" });
    expect((await POST(request)).status).toBe(429);
    expect(request.bodyUsed).toBe(false);
    expect(saveDmBackup).not.toHaveBeenCalled();
  });
});
