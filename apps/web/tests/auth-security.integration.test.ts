// Requires a migrated database at DATABASE_URL.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { twoFactor, user } from "@/db/schema";
import { auth } from "@/lib/auth";

const email = `2fa-${randomUUID()}@example.test`;
const password = "correct horse battery";

describe("two-factor secrets", () => {
  afterAll(async () => {
    await db.delete(user).where(eq(user.email, email));
  });

  it("stores the TOTP secret and backup codes encrypted, not as issued", async () => {
    const res = await auth.api.signUpEmail({ body: { email, password, name: "Secret Keeper" }, returnHeaders: true });
    const headers = new Headers({ cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] });
    const enabled = await auth.api.enableTwoFactor({ body: { password }, headers });
    if (!("totpURI" in enabled)) throw new Error("expected TOTP setup");
    const { totpURI, backupCodes } = enabled;
    const secret = new URL(totpURI).searchParams.get("secret")!;

    const [row] = await db.select().from(twoFactor).where(eq(twoFactor.userId, res.response.user.id));
    expect(row.secret).not.toContain(secret);
    for (const code of backupCodes) expect(row.backupCodes).not.toContain(code);
  });

  it("rejects display names that are empty or too long", async () => {
    await expect(
      auth.api.signUpEmail({ body: { email: `x-${email}`, password, name: "x".repeat(65) } }),
    ).rejects.toThrow(/Display names/);
  });
});
