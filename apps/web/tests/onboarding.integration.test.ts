import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { user } from "@/db/schema";
import { completeOnboarding, needsOnboarding } from "@/server/profile";
import { testUsers } from "./helpers";

describe("onboarding", () => {
  const users = testUsers();
  afterAll(() => users.cleanup());

  it("is pending for a new account and completes once", async () => {
    const id = await users.create("Onboarding newcomer");
    await db.update(user).set({ onboardedAt: null }).where(eq(user.id, id));
    expect(await needsOnboarding(id)).toBe(true);

    await completeOnboarding(id);
    const [first] = await db.select({ at: user.onboardedAt }).from(user).where(eq(user.id, id));
    expect(first.at).toBeInstanceOf(Date);
    expect(await needsOnboarding(id)).toBe(false);

    await completeOnboarding(id);
    const [second] = await db.select({ at: user.onboardedAt }).from(user).where(eq(user.id, id));
    expect(second.at).toEqual(first.at);
  });

  it("does not send unknown accounts to the onboarding", async () => {
    expect(await needsOnboarding("no-such-user")).toBe(false);
  });
});
