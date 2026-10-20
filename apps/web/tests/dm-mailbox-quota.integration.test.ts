// One contact cannot fill another person's device mailbox (or drain its prekeys) for everyone else.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { session } from "@/db/schema";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { createDirectConversation, handleCryptoRequest, registerDmDevice, respondToDirectRequest } from "@/server/direct-messages";
import { testUsers } from "./helpers";

const users = testUsers();
const matrix = (id: string) => `@${id}:opendiscord.local`;
type Person = { userId: string; sessionId: string; deviceId: string; secret: string };
let mallory: Person, carol: Person, victim: Person;

async function enroll(name: string): Promise<Person> {
  const person = { userId: await users.create(name), sessionId: randomUUID(), deviceId: randomUUID(), secret: randomBytes(32).toString("hex") };
  await db.insert(session).values({ id: person.sessionId, userId: person.userId, token: randomUUID(), createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
  await registerDmDevice(person.userId, person.sessionId, { id: person.deviceId, secret: person.secret, name: `${name} browser` });
  return person;
}
const cancel = (from: Person) => handleCryptoRequest(from, {
  kind: "send", requestId: randomUUID(), eventType: "m.key.verification.cancel",
  body: { messages: { [matrix(victim.userId)]: { [victim.deviceId]: { transaction_id: randomUUID(), code: "m.user", reason: "flood" } } } },
});

beforeAll(async () => {
  [mallory, carol, victim] = await Promise.all(["Mailbox Mallory", "Mailbox Carol", "Mailbox Victim"].map(enroll));
  const { communityId } = await createCommunity(victim.userId, "Mailbox community");
  for (const p of [mallory, carol]) {
    await acceptInvite(p.userId, await createInvite(victim.userId, communityId, { expiresInHours: 24, maxUses: null }));
    await respondToDirectRequest(victim.userId, await createDirectConversation(p.userId, victim.userId), "accepted");
  }
});
afterAll(() => users.cleanup());

describe("device mailbox quotas", () => {
  it("caps the undelivered events one sender has queued for one device, without blocking other senders", async () => {
    for (let i = 0; i < 32; i++) await cancel(mallory);
    await expect(cancel(mallory)).rejects.toThrow("too many undelivered events");
    await cancel(carol);
    const sync = await handleCryptoRequest(victim, { kind: "sync" }) as { cursor: string; events: { sender: string }[] };
    expect(sync.events.filter((e) => e.sender === matrix(mallory.userId))).toHaveLength(32);
    expect(sync.events.filter((e) => e.sender === matrix(carol.userId))).toHaveLength(1);
    // Once the device has consumed its mailbox, the sender may deliver again.
    await handleCryptoRequest(victim, { kind: "ack", cursor: sync.cursor });
    await cancel(mallory);
  }, 30_000);

  it("rate-limits one-time-key claims per claimer and target device", async () => {
    const fallback = { key: "f".repeat(43), fallback: true, signatures: {} };
    await handleCryptoRequest(victim, { kind: "upload", body: { fallback_keys: { "signed_curve25519:fallback": fallback } } });
    const claim = (from: Person) => handleCryptoRequest(from, { kind: "claim", requestId: randomUUID(), body: { one_time_keys: { [matrix(victim.userId)]: { [victim.deviceId]: "signed_curve25519" } } } });
    for (let i = 0; i < 10; i++) await claim(mallory);
    await expect(claim(mallory)).rejects.toThrow("too often");
    await expect(claim(carol)).resolves.toMatchObject({ one_time_keys: { [matrix(victim.userId)]: { [victim.deviceId]: expect.any(Object) } } });
  });
});
