import { eq } from "drizzle-orm";
import webpush from "web-push";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { db } from "@/db";
import { pushSubscription } from "@/db/schema";
import { testUsers } from "./helpers";

const users = testUsers();
const keys = webpush.generateVAPIDKeys();
vi.stubEnv("VAPID_PUBLIC_KEY", keys.publicKey);
vi.stubEnv("VAPID_PRIVATE_KEY", keys.privateKey);
vi.stubEnv("VAPID_SUBJECT", "mailto:ci@example.test");
// Import after setting disposable VAPID keys so this regression always executes.
const { MAX_SUBSCRIPTIONS_PER_USER, savePushSubscription } = await import("@/server/push");
let actor: string;
beforeEach(async () => { actor = await users.create("Parallel push"); });
afterAll(async () => { await users.cleanup(); vi.unstubAllEnvs(); });

const subscription = (suffix: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${actor}-${suffix}`,
  keys: { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) },
});

it("concurrent registrations cannot overrun the account's device cap", async () => {
  const results = await Promise.allSettled(Array.from({ length: MAX_SUBSCRIPTIONS_PER_USER * 2 }, (_, i) =>
    savePushSubscription(actor, subscription(String(i)))));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(MAX_SUBSCRIPTIONS_PER_USER);
  for (const result of results) {
    if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "conflict" });
  }
  expect(await db.$count(pushSubscription, eq(pushSubscription.userId, actor))).toBe(MAX_SUBSCRIPTIONS_PER_USER);
});

it("re-registering a device at capacity is allowed, importing another account's device is not", async () => {
  await Promise.all(Array.from({ length: MAX_SUBSCRIPTIONS_PER_USER }, (_, i) => savePushSubscription(actor, subscription(String(i)))));
  const [existing] = await db.select().from(pushSubscription).where(eq(pushSubscription.userId, actor));
  await savePushSubscription(actor, { ...subscription("unused"), endpoint: existing.endpoint });
  const other = await users.create("Other push owner");
  const incoming = subscription("transfer");
  await savePushSubscription(other, incoming);
  await expect(savePushSubscription(actor, incoming)).rejects.toMatchObject({ code: "conflict" });
  const [unchanged] = await db.select().from(pushSubscription).where(eq(pushSubscription.endpoint, incoming.endpoint));
  expect(unchanged.userId).toBe(other);
  expect(await db.$count(pushSubscription, eq(pushSubscription.userId, actor))).toBe(MAX_SUBSCRIPTIONS_PER_USER);
});
