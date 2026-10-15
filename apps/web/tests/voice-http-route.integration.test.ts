import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { channel, session, user } from "@/db/schema";
import { auth } from "@/lib/auth";
import { POST, GET, HEAD, PUT, PATCH, DELETE, OPTIONS } from "@/app/api/voice/control/route";
import { createCommunity } from "@/server/communities";
import { registerDmDevice, revokeDmDevice } from "@/server/direct-messages";
import { requireUser } from "@/server/session";
import { VOICE_HTTP_REQUEST_BYTES } from "@/server/voice-http";
import { REGISTRATION_HEADERS } from "./helpers";

const ids: string[] = [], origin = new URL(process.env.BETTER_AUTH_URL!).origin;
afterAll(async () => { if (ids.length) await db.delete(user).where(inArray(user.id, ids)); });
function request(body: unknown, headers: Record<string, string> = {}) { return new Request(`${origin}/api/voice/control`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); }
async function account() {
  const signup = await auth.api.signUpEmail({ headers: REGISTRATION_HEADERS, body: { email: `voice-route-${randomUUID()}@example.test`, password: "correct horse battery", name: "Voice HTTP route" }, returnHeaders: true });
  ids.push(signup.response.user.id);
  const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0];
  const actual = await requireUser(new Headers({ cookie }));
  const anchor = { id: randomUUID(), secret: "a".repeat(64), name: "HTTP enrollment" };
  await registerDmDevice(actual.id, actual.sessionId, anchor);
  const community = await createCommunity(actual.id, "Voice HTTP actual account");
  const [room] = await db.insert(channel).values({ communityId: community.communityId, kind: "voice", name: "http-control" }).returning();
  const input = { channelId: room.id, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: "b".repeat(64), consent: true };
  const headers = { cookie, "x-dm-device": anchor.id, "x-dm-device-secret": anchor.secret };
  return { actual, cookie, anchor, input, headers };
}
async function code(response: Response, status: number, code: string) { expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("access-control-allow-origin")).toBeNull(); expect(await response.json()).toEqual({ code }); }
describe("actual cookie-authenticated Voice route", () => {
  it("denies supported non-POST methods without caching", async () => { for (const handler of [GET, HEAD, PUT, PATCH, DELETE, OPTIONS]) await code(handler(), 405, "method_not_allowed"); });
  it("requires origin, JSON, real session and rejects alternate body authority", async () => {
    const a = await account();
    for (const headers of [{ origin: "https://foreign.test" }, { origin: "" }, { "sec-fetch-site": "cross-site" }, { "content-type": "text/plain" }]) await code(await POST(request({ action: "join", input: a.input }, { ...a.headers, ...headers })), 403, "forbidden");
    await code(await POST(request({ action: "join", input: a.input }, { "x-user-id": a.actual.id, "x-session-id": a.actual.sessionId, "x-dm-device": a.anchor.id, "x-dm-device-secret": a.anchor.secret })), 401, "unauthorized");
    await code(await POST(request({ action: "join", input: a.input, userId: a.actual.id }, a.headers)), 400, "invalid");
    await code(await POST(request({ action: "join", input: { ...a.input, sessionId: a.actual.sessionId } }, a.headers)), 400, "invalid");
    await code(await POST(request({ action: "join", input: a.input }, { ...a.headers, "x-dm-device-secret": "c".repeat(64) })), 403, "forbidden");
  });
  it("joins, heartbeats, syncs, rejects wrong member/other account and leaves through the real service", async () => {
    const a = await account(), other = await account();
    const joined = await POST(request({ action: "join", input: a.input }, a.headers)); expect(joined.status).toBe(200); const snapshot = await joined.json();
    const binding = { callId: snapshot.callId, memberId: snapshot.memberId, joinNonce: snapshot.joinNonce, expectedGeneration: snapshot.generation };
    const headers = { cookie: a.cookie, "x-voice-member": snapshot.memberId, "x-voice-secret": a.input.enrollmentSecret };
    const heartbeat = await POST(request({ action: "heartbeat", input: binding }, headers)); expect(heartbeat.status).toBe(200); expect(heartbeat.headers.get("cache-control")).toBe("private, no-store");
    const sync = await POST(request({ action: "crypto", input: { ...binding, request: { kind: "sync" } } }, headers)); expect(sync.status).toBe(200); expect(await sync.json()).toMatchObject({ events: [], oneTimeKeys: { signed_curve25519: 0 } });
    await code(await POST(request({ action: "heartbeat", input: binding }, { ...headers, "x-voice-secret": "c".repeat(64) })), 403, "forbidden");
    await code(await POST(request({ action: "heartbeat", input: binding }, { ...headers, cookie: other.cookie })), 403, "forbidden");
    const left = await POST(request({ action: "leave", input: binding }, headers)); expect(left.status).toBe(200);
    await code(await POST(request({ action: "crypto", input: { ...binding, request: { kind: "sync" } } }, headers)), 403, "forbidden");
  });
  it("does not replay authority after anchor revocation or session expiry/deletion", async () => {
    const a = await account();
    await revokeDmDevice(a.actual.id, a.anchor.id);
    await code(await POST(request({ action: "join", input: a.input }, a.headers)), 403, "forbidden");
    await db.update(session).set({ expiresAt: new Date(0) }).where(eq(session.id, a.actual.sessionId));
    await code(await POST(request({ action: "join", input: a.input }, a.headers)), 401, "unauthorized");
    await db.delete(session).where(eq(session.id, a.actual.sessionId));
    await code(await POST(request({ action: "join", input: a.input }, a.headers)), 401, "unauthorized");
  });
  it("bounds actual stream bytes with missing or misleading content length", async () => {
    for (const length of [undefined, "1", String(VOICE_HTTP_REQUEST_BYTES + 1)]) {
      let canceled = false;
      const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(VOICE_HTTP_REQUEST_BYTES + 1)); }, cancel() { canceled = true; } });
      const req = new Request(`${origin}/api/voice/control`, { method: "POST", headers: { origin, "content-type": "application/json", ...(length ? { "content-length": length } : {}) }, body, duplex: "half" } as RequestInit);
      await code(await POST(req), 400, "invalid");
      if (length !== String(VOICE_HTTP_REQUEST_BYTES + 1)) expect(canceled).toBe(true);
    }
  });
});
