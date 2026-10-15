import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { db } from "@/db";
import { user } from "@/db/schema";
import { auth } from "@/lib/auth";
import { getMinimumAge } from "@/server/operator-policy";
import { REGISTRATION_HEADER, REGISTRATION_POLICY_VERSION } from "@/lib/registration-policy";
import { REGISTRATION_HEADERS } from "./helpers";

const emails: string[] = [];
afterAll(async () => { if (emails.length) await db.delete(user).where(inArray(user.email, emails)); });
const account = () => {
  const email = `policy-${randomUUID()}@example.test`;
  emails.push(email);
  return { email, name: "Policy test", password: "correct horse battery" };
};

it("rejects direct registration without current age and policy attestation before creating an account", async () => {
  for (const headers of [undefined, { [REGISTRATION_HEADER]: "2020-01-01:age-13:terms" }, { [REGISTRATION_HEADER]: `${REGISTRATION_POLICY_VERSION}:age-${getMinimumAge() + 1}:terms` }, { [REGISTRATION_HEADER]: `${REGISTRATION_POLICY_VERSION}:age-${getMinimumAge()}` }]) {
    const body = account();
    await expect(auth.api.signUpEmail({ body, headers })).rejects.toThrow(new RegExp(`at least ${getMinimumAge()}`));
    expect(await db.query.user.findFirst({ where: (u, { eq }) => eq(u.email, body.email) })).toBeUndefined();
  }
});

it("accepts the current self-attestation without collecting a birth date", async () => {
  const body = account();
  const result = await auth.api.signUpEmail({ body, headers: REGISTRATION_HEADERS });
  expect(result.user.email).toBe(body.email);
  expect(await db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, result.user.id) })).toMatchObject({ email: body.email });
});
