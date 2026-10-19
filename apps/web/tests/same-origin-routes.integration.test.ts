// Cookie-authenticated mutating routes must refuse foreign origins even with a valid session
// (security audit 2026-10-19). Requires a migrated database at DATABASE_URL.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attachment, community, pushSubscription, user } from "@/db/schema";
import { auth } from "@/lib/auth";
import { createCommunity } from "@/server/communities";
import { mediaEnabled } from "@/server/media";
import { pushEnabled } from "@/server/push";
import { POST as upload } from "@/app/api/channels/[channelId]/attachments/route";
import { DELETE as unsubscribe, POST as subscribe } from "@/app/api/me/push/route";
import { REGISTRATION_HEADERS } from "./helpers";

const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const email = `origin-${randomUUID()}@example.test`;
let cookie: string, userId: string, channelId: string;

const request = (path: string, method: string, origin: string, headers: Record<string, string>, body: string) =>
  new Request(`${base}${path}`, { method, headers: { cookie, origin, ...headers }, body });
const subscription = JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/origin-test", keys: { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) } });

beforeAll(async () => {
  const res = await auth.api.signUpEmail({ headers: REGISTRATION_HEADERS, body: { email, password: `Pw-${randomUUID()}`, name: "Origin probe" }, returnHeaders: true });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  userId = res.response.user.id;
  ({ channelId } = await createCommunity(userId, "Origin checks"));
});
afterAll(async () => {
  await db.delete(community).where(eq(community.ownerId, userId));
  await db.delete(user).where(eq(user.email, email));
});

describe("same-origin enforcement with a valid session", () => {
  it.skipIf(!mediaEnabled)("refuses cross-origin attachment uploads", async () => {
    const send = (origin: string) => upload(
      request(`/api/channels/${channelId}/attachments`, "POST", origin, { "content-type": "application/zip", "content-length": "5", "x-filename": "a.zip" }, "hello"),
      { params: Promise.resolve({ channelId }) },
    );
    expect((await send("https://evil.example")).status).toBe(403);
    expect(await db.select().from(attachment).where(eq(attachment.uploaderId, userId))).toHaveLength(0);
  });

  it("refuses cross-origin push subscription changes", async () => {
    const headers = { "content-type": "text/plain" };
    expect((await subscribe(request("/api/me/push", "POST", "https://evil.example", headers, subscription))).status).toBe(403);
    expect(await db.select().from(pushSubscription).where(eq(pushSubscription.userId, userId))).toHaveLength(0);
    expect((await unsubscribe(request("/api/me/push", "DELETE", "https://evil.example", headers, subscription))).status).toBe(403);
    if (!pushEnabled) return;
    // The same request from this origin works, and the foreign DELETE above didn't remove it.
    expect((await subscribe(request("/api/me/push", "POST", new URL(base).origin, headers, subscription))).status).toBe(204);
    expect((await unsubscribe(request("/api/me/push", "DELETE", "https://evil.example", headers, subscription))).status).toBe(403);
    expect(await db.select().from(pushSubscription).where(eq(pushSubscription.userId, userId))).toHaveLength(1);
  });
});
