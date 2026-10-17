import { createEmailVerificationToken } from "better-auth/api";
import { GET } from "@/app/api/auth/[...all]/route";
import { REGISTRATION_HEADERS } from "./helpers";
// Requires a migrated database at DATABASE_URL.
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { instanceAdmin, instanceAuditLog, instanceSettings, session, user } from "@/db/schema";
import { auth } from "@/lib/auth";
import { requireMember } from "@/server/access";
import { createCommunity } from "@/server/communities";
import * as admin from "@/server/instance-admin";
import { AccountBlocked, assertActiveUser, getInstanceSettings } from "@/server/instance-policy";
import { testUsers } from "./helpers";

const fixtures = testUsers();
const password = "correct horse battery";
const emails: string[] = [];
let root: admin.AdminActor;
let previous: boolean;

async function signUp(name: string) {
  const email = `alpha-${randomUUID()}@example.test`;
  emails.push(email);
  return auth.api.signUpEmail({ headers: REGISTRATION_HEADERS, body: { email, password, name } }).then(
    (res) => ({ email, error: null, res }),
    (error: { body?: { code?: string } }) => ({ email, error, res: null }),
  );
}
const statusOf = async (email: string) =>
  (await db.select({ s: user.approvalStatus, id: user.id }).from(user).where(eq(user.email, email)))[0];

describe("closed alpha", () => {
  beforeAll(async () => {
    previous = (await getInstanceSettings()).closedAlpha;
    const rootId = await fixtures.create("Alpha operator");
    await db.insert(instanceAdmin).values({ userId: rootId });
    const sessionId = randomUUID();
    await db.insert(session).values({ id: sessionId, userId: rootId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
    root = { userId: rootId, sessionId };
  });
  afterAll(async () => {
    await db.update(instanceSettings).set({ closedAlpha: previous });
    await db.delete(instanceAuditLog).where(eq(instanceAuditLog.actorId, root.userId));
    await db.delete(instanceAdmin).where(eq(instanceAdmin.userId, root.userId));
    if (emails.length) await db.delete(user).where(inArray(user.email, emails));
    await fixtures.cleanup();
  });

  it("only lets instance admins toggle it, with a reason, and audits the change", async () => {
    const outsider = await fixtures.create("Not an admin");
    await expect(admin.setClosedAlpha({ userId: outsider, sessionId: root.sessionId }, true, "Trying")).rejects.toThrow(/administrator access/);
    await expect(admin.setClosedAlpha(root, true, " ")).rejects.toThrow(/reason/);
    await admin.setClosedAlpha(root, true, "Start the alpha");
    expect((await getInstanceSettings()).closedAlpha).toBe(true);
    const [log] = await db.select().from(instanceAuditLog).where(eq(instanceAuditLog.actorId, root.userId));
    expect(log.action).toBe("instance.closed_alpha.enable");
  });

  it("creates new accounts as pending and refuses them a session", async () => {
    const { email, error } = await signUp("Hopeful");
    expect(error?.body?.code).toBe("ACCOUNT_PENDING");
    const row = await statusOf(email);
    expect(row.s).toBe("pending");
    expect(await db.select().from(session).where(eq(session.userId, row.id))).toHaveLength(0);
    await expect(auth.api.signInEmail({ body: { email, password } })).rejects.toMatchObject({ body: { code: "ACCOUNT_PENDING" } });
    await expect(assertActiveUser(row.id)).rejects.toBeInstanceOf(AccountBlocked);
  });

  it("redirects a verified pending account to the approval screen without creating a session", async () => {
    const { email } = await signUp("Verified applicant");
    const row = await statusOf(email);
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, row.id));
    const token = await createEmailVerificationToken((await auth.$context).secret, email);
    const url = new URL("/api/auth/verify-email", (await auth.$context).baseURL);
    url.searchParams.set("token", token);
    url.searchParams.set("callbackURL", "/app");
    const response = await GET(new Request(url));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in?error=pending");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await db.select().from(user).where(eq(user.id, row.id)))[0].emailVerified).toBe(true);
    expect(await db.select().from(session).where(eq(session.userId, row.id))).toHaveLength(0);
  });

  it("doesn't let clients pick their own approval status", async () => {
    const email = `alpha-${randomUUID()}@example.test`;
    emails.push(email);
    await auth.api.signUpEmail({ headers: REGISTRATION_HEADERS, body: { email, password, name: "Sneaky", approvalStatus: "approved" } as never }).catch(() => null);
    expect((await statusOf(email))?.s ?? "pending").toBe("pending");
  });

  it("approves and rejects through audited admin actions", async () => {
    const approved = await signUp("Approved person");
    const rejected = await signUp("Rejected person");
    const a = await statusOf(approved.email);
    const r = await statusOf(rejected.email);
    expect((await admin.adminDashboard(root, "", "open", "pending")).users.map((u) => u.id)).toEqual(expect.arrayContaining([a.id, r.id]));

    await admin.setApproval(root, a.id, "approved", "Known tester");
    await expect(admin.setApproval(root, a.id, "approved", "Again")).rejects.toThrow(/already approved/);
    await expect(admin.setApproval(root, a.id, "rejected", "Too late")).rejects.toThrow(/Only pending/);
    const signedIn = await auth.api.signInEmail({ body: { email: approved.email, password } });
    expect(signedIn.token).toBeTruthy();

    await admin.setApproval(root, r.id, "rejected", "Not part of this wave");
    await expect(auth.api.signInEmail({ body: { email: rejected.email, password } })).rejects.toMatchObject({ body: { code: "ACCOUNT_REJECTED" } });
    const actions = (await db.select().from(instanceAuditLog).where(inArray(instanceAuditLog.targetId, [a.id, r.id]))).map((l) => l.action);
    expect(actions.sort()).toEqual(["user.approve", "user.reject"]);
  });

  it("gates community access server-side, but never instance admins", async () => {
    const owner = await fixtures.create("Grandfathered owner");
    const { communityId } = await createCommunity(owner, "Alpha community");
    await db.update(user).set({ approvalStatus: "pending" }).where(eq(user.id, owner));
    await expect(requireMember(db, communityId, owner)).rejects.toBeInstanceOf(AccountBlocked);
    await db.update(user).set({ approvalStatus: "pending" }).where(eq(user.id, root.userId));
    await expect(assertActiveUser(root.userId)).resolves.toBeUndefined();
    await db.update(user).set({ approvalStatus: "approved" }).where(eq(user.id, root.userId));
  });

  it("restores normal access when turned off, but keeps rejections", async () => {
    const { email } = await signUp("Waiting person");
    const declined = await signUp("Declined person");
    await admin.setApproval(root, (await statusOf(declined.email)).id, "rejected", "Not this time");
    await admin.setClosedAlpha(root, false, "Open beta");
    const res = await auth.api.signInEmail({ body: { email, password } });
    expect(res.token).toBeTruthy();
    await expect(auth.api.signInEmail({ body: { email: declined.email, password } })).rejects.toMatchObject({ body: { code: "ACCOUNT_REJECTED" } });
    const fresh = await signUp("Open signup");
    expect(fresh.res?.token).toBeTruthy();
    expect((await statusOf(fresh.email)).s).toBe("approved");
  });
});
