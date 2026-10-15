import { randomBytes, randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { authSecrets } from "@/lib/auth-secrets";

it("keeps legacy and previous-version TOTP material readable through native key rotation", async () => {
  const legacy = randomBytes(32).toString("base64");
  const first = randomBytes(32).toString("base64");
  const second = randomBytes(32).toString("base64");
  const instance = (keys?: string) => betterAuth({
    secret: legacy,
    secrets: authSecrets(keys),
    baseURL: "http://localhost:3000",
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    plugins: [twoFactor()],
  });
  const original = instance();
  const migrated = instance(`1:${first}`);
  const rotated = instance(`2:${second},1:${first}`);
  const password = "rotation-test-password";
  const emails = [`rotation-legacy-${randomUUID()}@example.test`, `rotation-v1-${randomUUID()}@example.test`];
  try {
    for (const [index, source] of [original, migrated].entries()) {
      const signup = await source.api.signUpEmail({ body: { email: emails[index], password, name: "Rotation probe" }, returnHeaders: true });
      const headers = new Headers({ cookie: (signup.headers.get("set-cookie") ?? "").split(";")[0] });
      const enabled = await source.api.enableTwoFactor({ headers, body: { password } });
      if (!("totpURI" in enabled)) throw new Error("Expected TOTP setup");
      const [row] = await db.select().from(schema.twoFactor).where(eq(schema.twoFactor.userId, signup.response.user.id));
      const current = await rotated.$context;
      const secret = await symmetricDecrypt({ key: current.secretConfig, data: row.secret });
      expect(secret).toBe(new URL(enabled.totpURI).searchParams.get("secret"));
      const codes = JSON.parse(await symmetricDecrypt({ key: current.secretConfig, data: row.backupCodes }));
      expect(codes).toEqual(enabled.backupCodes);
      if (index === 1) {
        const retired = await instance(`2:${second}`).$context;
        await expect(symmetricDecrypt({ key: retired.secretConfig, data: row.secret })).rejects.toThrow();
      }
      const freshCiphertext = await symmetricEncrypt({ key: current.secretConfig, data: secret });
      expect(await symmetricDecrypt({ key: current.secretConfig, data: freshCiphertext })).toBe(secret);
      const previous = await migrated.$context;
      await expect(symmetricDecrypt({ key: previous.secretConfig, data: freshCiphertext })).rejects.toThrow();
      // Obtain a cookie signed by the new primary key; cookie continuity is not promised.
      const signin = await rotated.api.signInEmail({ body: { email: emails[index], password }, returnHeaders: true });
      const rotatedHeaders = new Headers({ cookie: (signin.headers.get("set-cookie") ?? "").split(";")[0] });
      const recovered = await rotated.api.getTOTPURI({ headers: rotatedHeaders, body: { password } });
      expect(new URL(recovered.totpURI).searchParams.get("secret")).toBe(secret);
    }
  } finally {
    for (const email of emails) await db.delete(schema.user).where(eq(schema.user.email, email));
  }
});
