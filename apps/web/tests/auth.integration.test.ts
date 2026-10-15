// Requires a migrated database at DATABASE_URL (see docker-compose.yml / CI).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { user } from "@/db/schema";
import { auth } from "@/lib/auth";

const email = `test-${randomUUID()}@example.test`;
const password = "correct horse battery";

describe("email + password auth", () => {
  afterAll(async () => {
    await db.delete(user).where(eq(user.email, email));
  });

  it("creates an account and returns a session", async () => {
    const res = await auth.api.signUpEmail({ body: { email, password, name: "Tester" } });
    expect(res.user.email).toBe(email);
    expect(res.token).toBeTruthy();
  });

  it("signs in with the correct password", async () => {
    const res = await auth.api.signInEmail({ body: { email, password } });
    expect(res.user.email).toBe(email);
    expect(res.token).toBeTruthy();
  });

  it("rejects a wrong password", async () => {
    await expect(auth.api.signInEmail({ body: { email, password: "wrong password!!" } })).rejects.toThrow();
  });

  it("does not store the plaintext password", async () => {
    const rows = await db.query.account.findMany({ where: (a, { eq }) => eq(a.providerId, "credential") });
    expect(rows.every((r) => r.password !== password)).toBe(true);
  });
});
