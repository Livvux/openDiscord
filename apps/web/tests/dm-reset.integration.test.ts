import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { dmBackup, dmDevice, dmIdentity, dmKey, dmMailbox, dmSignature, instanceAuditLog, session, user } from "@/db/schema";
import { auth } from "@/lib/auth";
import { GET, POST } from "@/app/api/dm/reset/route";
import { handleCryptoRequest, registerDmDevice } from "@/server/direct-messages";
import { dmResetState, resetDmIdentity } from "@/server/dm-reset";
import { REGISTRATION_HEADERS } from "./helpers";
import { authenticatorCode } from "./totp";

const accounts: string[] = [];
const password = "correct horse battery";
const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin;
afterAll(async () => {
  if (!accounts.length) return;
  await db.delete(instanceAuditLog).where(inArray(instanceAuditLog.actorId, accounts));
  await db.delete(user).where(inArray(user.id, accounts));
});
async function account(twoFactor = false) {
  const result = await auth.api.signUpEmail({ headers: REGISTRATION_HEADERS, body: { email: `reset-${randomUUID()}@example.test`, name: "Identity reset fixture", password }, returnHeaders: true });
  const userId = result.response.user.id; accounts.push(userId);
  let headers = new Headers({ cookie: result.headers.get("set-cookie")!.split(";")[0], origin, "content-type": "application/json" });
  let secret: string | undefined;
  if (twoFactor) {
    const setup = await auth.api.enableTwoFactor({ headers, body: { password } });
    if (!("totpURI" in setup)) throw new Error("Missing authenticator setup");
    secret = new URL(setup.totpURI).searchParams.get("secret")!;
    const confirmed = await auth.api.verifyTOTP({ headers, body: { code: authenticatorCode(secret) }, returnHeaders: true });
    headers = new Headers({ cookie: confirmed.headers.get("set-cookie")!.split(";")[0], origin, "content-type": "application/json" });
  }
  const current = (await auth.api.getSession({ headers }))!;
  await db.insert(dmIdentity).values({ userId, keys: { master_key: { keys: { "ed25519:fixture": "a".repeat(43) } } } });
  return { userId, headers, sessionId: current.session.id, secret };
}
const request = (headers: Headers, body: unknown) => new Request(`${origin}/api/dm/reset`, { method: "POST", headers, body: JSON.stringify(body) });

describe("explicit encryption identity reset", () => {
  it("requires password authentication, fresh active session and current identity confirmation", async () => {
    const a = await account();
    const state = await dmResetState(a.userId, a.sessionId);
    expect(state.freshSession).toBe(true);
    expect((await GET(new Request(`${origin}/api/dm/reset`, { headers: a.headers }))).status).toBe(200);
    const foreign = new Headers(a.headers); foreign.set("origin", "https://unrelated.example");
    expect((await POST(request(foreign, { identity: state.identity, password, confirmed: true }))).status).toBe(403);
    expect((await POST(request(a.headers, { identity: state.identity, password, confirmed: false }))).status).toBe(400);
    await expect(dmResetState(a.userId, randomUUID())).rejects.toThrow("Sign in again");
    expect((await POST(request(a.headers, { identity: state.identity, password: "wrong", confirmed: true }))).status).toBe(403);
    await db.update(session).set({ createdAt: new Date(Date.now() - 6 * 60_000) }).where(eq(session.id, a.sessionId));
    await expect(resetDmIdentity(a.userId, a.sessionId, { identity: state.identity!, twoFactorEnabled: false })).rejects.toThrow("five minutes");
    expect((await POST(request(a.headers, { identity: state.identity, password, confirmed: true }))).status).toBe(403);
    expect(await db.select().from(dmIdentity).where(eq(dmIdentity.userId, a.userId))).toHaveLength(1);
  });
  it("rejects a registration already queued when its account session is revoked", async () => {
    const a = await account();
    const deviceId = randomUUID(), secret = randomBytes(32).toString("hex");
    let registration: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(810025)`);
      registration = registerDmDevice(a.userId, a.sessionId, { id: deviceId, secret, name: "Queued old session" }).catch((error: unknown) => error);
      // Suites run serially: observe the pending advisory lock before revoking the
      // session, making this a queued-request race rather than a timing guess.
      await expect.poll(async () => (await tx.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_locks where locktype = 'advisory' and objid = 810025 and not granted) as waiting`)).rows[0]?.waiting).toBe(true);
      await tx.delete(session).where(eq(session.id, a.sessionId));
    });
    expect(await registration).toMatchObject({ code: "forbidden" });
    expect(await db.select().from(dmDevice).where(eq(dmDevice.id, deviceId))).toHaveLength(0);
    await expect(handleCryptoRequest({ userId: a.userId, sessionId: a.sessionId, deviceId, secret }, { kind: "signing", body: {} })).rejects.toThrow("session is unavailable");
  });
  it("requires enabled TOTP and atomically invalidates old devices, backups, signatures and sessions", async () => {
    const a = await account(true);
    const state = await dmResetState(a.userId, a.sessionId);
    const deviceId = randomUUID(), otherSession = randomUUID();
    await db.insert(dmDevice).values({ id: deviceId, userId: a.userId, name: "Old browser", secretHash: "a".repeat(64), keys: { keys: {} } });
    await db.insert(dmKey).values({ deviceId, keyId: "signed_curve25519:fixture", content: { key: "a" }, fallback: false });
    await db.insert(dmMailbox).values({ deviceId, senderId: a.userId, event: { type: "m.room.encrypted" } });
    await db.insert(dmSignature).values({ signerId: a.userId, targetId: a.userId, keyId: deviceId, signatures: {} });
    await db.insert(dmBackup).values({ id: randomUUID(), userId: a.userId, ciphertext: "ciphertext" });
    await db.insert(session).values({ id: otherSession, token: randomUUID(), userId: a.userId, createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    expect((await POST(request(a.headers, { identity: state.identity, password, confirmed: true }))).status).toBe(403);
    const response = await POST(request(a.headers, { identity: state.identity, password, code: authenticatorCode(a.secret!), confirmed: true }));
    expect(response.status).toBe(200);
    const [device] = await db.select().from(dmDevice).where(eq(dmDevice.id, deviceId));
    expect(device.revokedAt).not.toBeNull(); expect(device.keys).toBeNull();
    expect(await db.select().from(dmIdentity).where(eq(dmIdentity.userId, a.userId))).toHaveLength(0);
    expect(await db.select().from(dmKey).where(eq(dmKey.deviceId, deviceId))).toHaveLength(0);
    expect(await db.select().from(dmMailbox).where(eq(dmMailbox.deviceId, deviceId))).toHaveLength(0);
    expect(await db.select().from(dmBackup).where(eq(dmBackup.userId, a.userId))).toHaveLength(0);
    expect(await db.select().from(dmSignature).where(eq(dmSignature.signerId, a.userId))).toHaveLength(0);
    expect(await db.select().from(session).where(and(eq(session.userId, a.userId), eq(session.id, otherSession)))).toHaveLength(0);
    expect(await db.select().from(session).where(eq(session.id, a.sessionId))).toHaveLength(0);
    await expect(resetDmIdentity(a.userId, a.sessionId, { identity: state.identity!, twoFactorEnabled: true })).rejects.toThrow("Sign in again");
  });
});
