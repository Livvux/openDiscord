import { REGISTRATION_HEADERS } from "./helpers";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { session, user } from "@/db/schema";

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn<(...args: string[]) => Promise<void>>().mockResolvedValue(undefined) }));
vi.mock("@/lib/mail", () => ({ mailEnabled: true, sendMail }));
import { auth } from "@/lib/auth";

const ids: string[] = [];
const password = "correct horse battery";
const address = (name: string) => `${name}-${randomUUID()}@example.test`;

async function verifiedAccount(email: string) {
  const result = await auth.api.signUpEmail({ headers: REGISTRATION_HEADERS, body: { email, password, name: "Email correction test" } });
  ids.push(result.user.id);
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, result.user.id));
  const signedIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  const cookie = signedIn.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Expected authentication cookie");
  return { id: result.user.id, headers: new Headers({ cookie }) };
}

function tokenFromLastEmail() {
  const text = sendMail.mock.calls.at(-1)?.[2] ?? "";
  const url = text.match(/https?:\/\/[^\s]+/)?.[0];
  if (!url) throw new Error("Expected verification message");
  return new URL(url).searchParams.get("token")!;
}

describe("verified email correction", () => {
  afterAll(async () => { if (ids.length) await db.delete(user).where(inArray(user.id, ids)); });

  it("requires confirmation at the current address and verification at the new one", async () => {
    const current = address("current");
    const next = address("next");
    const account = await verifiedAccount(current);
    sendMail.mockClear();
    await auth.api.changeEmail({ body: { newEmail: next }, headers: account.headers });
    expect(sendMail.mock.calls.at(-1)?.[0]).toBe(current);
    expect((await db.select().from(user).where(eq(user.id, account.id)))[0].email).toBe(current);
    const confirmation = tokenFromLastEmail();
    await auth.api.verifyEmail({ query: { token: confirmation }, headers: account.headers });
    expect(sendMail.mock.calls.at(-1)?.[0]).toBe(next);
    expect((await db.select().from(user).where(eq(user.id, account.id)))[0].email).toBe(current);
    const verification = tokenFromLastEmail();
    expect(verification).not.toBe(confirmation);
    await auth.api.verifyEmail({ query: { token: verification }, headers: account.headers });
    const [changed] = await db.select().from(user).where(eq(user.id, account.id));
    expect(changed.email).toBe(next);
    expect(changed.emailVerified).toBe(true);
    await expect(auth.api.verifyEmail({ query: { token: verification }, headers: account.headers })).rejects.toThrow();
  });

  it("does not expose whether another account owns the requested address", async () => {
    const occupied = address("occupied");
    await verifiedAccount(occupied);
    const requester = await verifiedAccount(address("requester"));
    sendMail.mockClear();
    const result = await auth.api.changeEmail({ body: { newEmail: occupied }, headers: requester.headers });
    expect(result.status).toBe(true);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("rejects signed-out and stale sessions", async () => {
    await expect(auth.api.changeEmail({ body: { newEmail: address("unauthenticated") } })).rejects.toThrow();
    const account = await verifiedAccount(address("stale"));
    await db.update(session).set({ createdAt: new Date(Date.now() - 61 * 60_000) }).where(eq(session.userId, account.id));
    await expect(auth.api.changeEmail({ body: { newEmail: address("fresh-required") }, headers: account.headers })).rejects.toThrow();
  });
});
