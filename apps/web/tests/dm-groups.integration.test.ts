import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attachment, dmConversation, dmMember, friendship, session, user, userSuspension } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { blockUser } from "@/server/blocks";
import { appendDirectMessage, createDirectConversation, directAttachmentFor, reportDirectMessage, exportDirectData, handleCryptoRequest, listDirectConversations, listDirectMessages, listDmDevices, markDirectConversationRead, registerDmDevice } from "@/server/direct-messages";
import { DM_GROUP_MAX_MEMBERS } from "@/lib/dm/contracts";
import { addGroupMembers, createGroupConversation, leaveGroup, removeGroupMember, renameGroup } from "@/server/dm-groups";
import { hub, userTopic, type HubEvent } from "@/server/realtime";
import { testUsers } from "./helpers";

const users = testUsers();
const matrix = (id: string) => `@${id}:opendiscord.local`;
type Person = { id: string; device: string; session: string; secret: string };
const people: Record<string, Person> = {};
const auth = (p: Person) => ({ userId: p.id, sessionId: p.session, deviceId: p.device, secret: p.secret });
const envelope = (p: Person) => ({ algorithm: "m.megolm.v1.aes-sha2", sender_key: `${p.id.slice(0, 8)}${"a".repeat(35)}`, device_id: p.device, session_id: "b".repeat(43), ciphertext: randomBytes(48).toString("base64") });
const befriend = (a: string, b: string) => db.insert(friendship).values({ firstId: [a, b].sort()[0], secondId: [a, b].sort()[1], requestedBy: a, status: "accepted" });
let group: string;

async function enroll(name: string): Promise<Person> {
  const id = await users.create(`Group ${name}`);
  const person = { id, device: randomUUID(), session: randomUUID(), secret: randomBytes(32).toString("hex") };
  await db.insert(session).values({ id: person.session, userId: id, token: randomUUID(), createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
  await registerDmDevice(id, person.session, { id: person.device, secret: person.secret, name: `${name} browser` });
  await handleCryptoRequest(auth(person), { kind: "upload", body: { device_keys: { user_id: matrix(id), device_id: person.device, algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"], keys: { [`curve25519:${person.device}`]: envelope(person).sender_key, [`ed25519:${person.device}`]: "e".repeat(43) }, signatures: {} } } });
  return person;
}
beforeAll(async () => {
  for (const name of ["Gina", "Hugo", "Ivy", "Jon", "Kim", "Stranger"]) people[name] = await enroll(name);
  // Gina is friends with everyone but Stranger; the others don't know each other.
  for (const name of ["Hugo", "Ivy", "Jon", "Kim"]) await befriend(people.Gina.id, people[name].id);
});
afterAll(() => users.cleanup());

describe("encrypted group conversations", () => {
  it("creates a group of 3–8 from the creator's friends only", async () => {
    const { Gina, Hugo, Ivy, Stranger } = people;
    await expect(createGroupConversation(Gina.id, { members: [Hugo.id] })).rejects.toThrow("at least");
    await expect(createGroupConversation(Gina.id, { members: [Hugo.id, Stranger.id] })).rejects.toThrow("friends");
    await expect(createGroupConversation(Gina.id, { members: Array.from({ length: 10 }, () => randomUUID()) })).rejects.toThrow();
    group = await createGroupConversation(Gina.id, { members: [Hugo.id, Ivy.id], name: "Weekend plans" });
    const listed = (await listDirectConversations(Hugo.id)).find((c) => c.id === group)!;
    expect(listed).toMatchObject({ kind: "group", name: "Weekend plans", status: "accepted", unread: 0 });
    expect(listed.members.map((m) => m.id).sort()).toEqual([Gina.id, Ivy.id].sort());
    expect(await listDirectConversations(Stranger.id)).toEqual([]);
    // A 1:1 conversation between two friends stays separate and unchanged.
    const direct = await createDirectConversation(Gina.id, Hugo.id);
    expect((await listDirectConversations(Gina.id)).find((c) => c.id === direct)).toMatchObject({ kind: "direct", peerId: Hugo.id, members: [expect.objectContaining({ id: Hugo.id })] });
  });

  it("lets members exchange device keys and ciphertext, and nobody else", async () => {
    const { Gina, Hugo, Ivy, Stranger } = people;
    // Hugo and Ivy are not friends and share no community: only the group makes them reachable.
    const query = await handleCryptoRequest(auth(Hugo), { kind: "query", body: { device_keys: { [matrix(Gina.id)]: [], [matrix(Ivy.id)]: [] } } });
    expect(Object.keys(query.device_keys as object).sort()).toEqual([matrix(Gina.id), matrix(Ivy.id)].sort());
    expect((await listDmDevices(Hugo.id, Ivy.id)).map((d) => d.id)).toEqual([Ivy.device]);
    await expect(handleCryptoRequest(auth(Stranger), { kind: "query", body: { device_keys: { [matrix(Ivy.id)]: [] } } })).rejects.toThrow("not found");
    const events: HubEvent[] = [];
    const unsubscribe = hub.subscribe(userTopic(Ivy.id), (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 300));
    const sent = await appendDirectMessage(auth(Hugo), group, { transactionId: randomUUID(), content: envelope(Hugo) });
    await expect.poll(() => events.find((e) => e.type === "dm.changed" && e.reason === "message")).toEqual({ type: "dm.changed", userId: Ivy.id, conversationId: group, reason: "message", senderId: Hugo.id });
    unsubscribe();
    for (const reader of [Gina, Ivy]) expect((await listDirectConversations(reader.id)).find((c) => c.id === group)!.unread).toBe(1);
    expect((await listDirectMessages(Ivy.id, group)).messages.map((m) => m.id)).toEqual([sent.id]);
    await markDirectConversationRead(Ivy.id, group, sent.id);
    expect((await listDirectConversations(Ivy.id)).find((c) => c.id === group)!.unread).toBe(0);
    await expect(listDirectMessages(Stranger.id, group)).rejects.toThrow("not found");
    await expect(appendDirectMessage(auth(Stranger), group, { transactionId: randomUUID(), content: envelope(Stranger) })).rejects.toThrow("not found");
  });

  it("adds friends without old history, renames, removes and leaves with membership enforced at once", async () => {
    const { Gina, Hugo, Ivy, Jon, Kim } = people;
    await expect(addGroupMembers(Hugo.id, group, [Jon.id])).rejects.toThrow("friends");
    await addGroupMembers(Gina.id, group, [Jon.id]);
    // A new member starts after existing history and with nothing unread.
    expect((await listDirectMessages(Jon.id, group)).messages).toEqual([]);
    expect((await listDirectConversations(Jon.id)).find((c) => c.id === group)!.unread).toBe(0);
    await renameGroup(Ivy.id, group, "  Trip  ");
    expect((await listDirectConversations(Gina.id)).find((c) => c.id === group)!.name).toBe("Trip");
    await expect(renameGroup(Ivy.id, group, "x".repeat(101))).rejects.toThrow();
    // Only the creator removes others; anyone can leave.
    await expect(removeGroupMember(Hugo.id, group, Ivy.id)).rejects.toThrow();
    await removeGroupMember(Gina.id, group, Ivy.id);
    await expect(listDirectMessages(Ivy.id, group)).rejects.toThrow("not found");
    await expect(handleCryptoRequest(auth(Ivy), { kind: "query", body: { device_keys: { [matrix(Jon.id)]: [] } } })).rejects.toThrow("not found");
    // Remaining members may still look up her public keys to authenticate her earlier messages, but never deliver keys to her.
    await handleCryptoRequest(auth(Gina), { kind: "query", body: { device_keys: { [matrix(Ivy.id)]: [] } } });
    await expect(handleCryptoRequest(auth(Gina), { kind: "claim", requestId: randomUUID(), body: { one_time_keys: { [matrix(Ivy.id)]: { [Ivy.device]: "signed_curve25519" } } } })).rejects.toThrow("not found");
    await expect(handleCryptoRequest(auth(Gina), { kind: "send", requestId: randomUUID(), eventType: "m.key.verification.done", body: { messages: { [matrix(Ivy.id)]: { "*": { transaction_id: randomUUID() } } } } })).rejects.toThrow("not found");
    // Former members stay known as senders of earlier messages, marked as left.
    expect((await listDirectConversations(Gina.id)).find((c) => c.id === group)!.members.find((m) => m.id === Ivy.id)).toMatchObject({ left: true });
    await leaveGroup(Hugo.id, group);
    expect((await listDirectConversations(Hugo.id)).some((c) => c.id === group)).toBe(false);
    await expect(addGroupMembers(Gina.id, group, Array.from({ length: 8 }, () => Kim.id))).resolves.toBeUndefined();
    expect((await listDirectConversations(Gina.id)).find((c) => c.id === group)!.members.filter((m) => !m.left).map((m) => m.id).sort()).toEqual([Jon.id, Kim.id].sort());
  });

  it("blocked members exchange no keys; the creator's leaving hands the group on; deletion cascades", async () => {
    const { Gina, Hugo, Jon, Kim } = people;
    await blockUser(Jon.id, Kim.id);
    expect((await listDirectConversations(Jon.id)).find((c) => c.id === group)!.members.find((m) => m.id === Kim.id)).toMatchObject({ blocked: true });
    await expect(handleCryptoRequest(auth(Jon), { kind: "query", body: { device_keys: { [matrix(Kim.id)]: [] } } })).rejects.toThrow("not found");
    await leaveGroup(Gina.id, group);
    // The longest-standing remaining member may now manage the group.
    await removeGroupMember(Jon.id, group, Kim.id);
    expect(JSON.stringify(await exportDirectData(Jon.id))).toContain(group);
    // Deleting the creator's account keeps the group for the others.
    // (Jon and Kim, who have a block, can no longer be put in a group together.)
    await expect(createGroupConversation(Gina.id, { members: [Jon.id, Kim.id] })).rejects.toThrow("block");
    const other = await createGroupConversation(Gina.id, { members: [Jon.id, Hugo.id] });
    await db.delete(user).where(eq(user.id, Gina.id));
    expect((await listDirectConversations(Hugo.id)).find((c) => c.id === other)!.members.map((m) => m.id)).toEqual([Jon.id]);
    await db.delete(user).where(eq(user.id, Jon.id));
    // The last member is gone, so is the group and its ciphertext.
    expect(await db.select().from(dmConversation).where(eq(dmConversation.id, group))).toEqual([]);
    await leaveGroup(Hugo.id, other);
    expect(await db.select().from(dmConversation).where(eq(dmConversation.id, other))).toEqual([]);
  });
});

describe("group hardening", () => {
  const p: Record<string, Person> = {};
  let g: string;
  beforeAll(async () => {
    for (const name of ["Owner", "Ann", "Ben", "Cal", "Dee"]) p[name] = await enroll(name);
    for (const name of ["Ann", "Ben", "Cal", "Dee"]) await befriend(p.Owner.id, p[name].id);
    await befriend(p.Ann.id, p.Dee.id);
    g = await createGroupConversation(p.Owner.id, { members: [p.Ann.id, p.Ben.id] });
  });

  it("a suspended or former member never bricks key lookup for the rest of the group", async () => {
    await db.insert(userSuspension).values({ userId: p.Ben.id, reason: "test" });
    try {
      const query = await handleCryptoRequest(auth(p.Owner), { kind: "query", body: { device_keys: { [matrix(p.Ann.id)]: [], [matrix(p.Ben.id)]: [] } } });
      expect(Object.keys(query.device_keys as object)).toContain(matrix(p.Ben.id));
      // Key delivery to the suspended member is skipped, not an error for the whole request.
      const claim = await handleCryptoRequest(auth(p.Owner), { kind: "claim", requestId: randomUUID(), body: { one_time_keys: { [matrix(p.Ann.id)]: { [p.Ann.device]: "signed_curve25519" }, [matrix(p.Ben.id)]: { [p.Ben.device]: "signed_curve25519" } } } });
      expect((claim.one_time_keys as Record<string, object>)[matrix(p.Ben.id)]).toEqual({});
      await handleCryptoRequest(auth(p.Owner), { kind: "send", requestId: randomUUID(), eventType: "m.key.verification.done", body: { messages: { [matrix(p.Ben.id)]: { "*": { transaction_id: randomUUID() } } } } });
    } finally { await db.delete(userSuspension).where(eq(userSuspension.userId, p.Ben.id)); }
  });

  it("refuses adds where anyone in the group and anyone added have a block, and groups grant no 1:1 requests", async () => {
    // Ann and Ben share only the group: no message request between them.
    await expect(createDirectConversation(p.Ann.id, p.Ben.id)).rejects.toThrow("not found");
    await befriend(p.Ben.id, p.Cal.id);
    await blockUser(p.Ben.id, p.Cal.id);
    await expect(addGroupMembers(p.Owner.id, g, [p.Cal.id])).rejects.toThrow("block");
    await expect(createGroupConversation(p.Owner.id, { members: [p.Ben.id, p.Cal.id] })).rejects.toThrow("block");
  });

  it("only the owner re-adds someone they removed", async () => {
    await removeGroupMember(p.Owner.id, g, p.Ben.id);
    await addGroupMembers(p.Owner.id, g, [p.Dee.id]);
    await removeGroupMember(p.Owner.id, g, p.Dee.id);
    await expect(addGroupMembers(p.Ann.id, g, [p.Dee.id])).rejects.toThrow("owner");
    await addGroupMembers(p.Owner.id, g, [p.Dee.id]);
    expect((await listDirectConversations(p.Ann.id)).find((c) => c.id === g)!.members.find((m) => m.id === p.Dee.id)).toMatchObject({ left: false });
  });

  it("a send cannot commit after a concurrent removal of its sender", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const removal = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${g}, 34))`);
      await tx.update(dmMember).set({ leftAt: new Date() }).where(and(eq(dmMember.conversationId, g), eq(dmMember.userId, p.Dee.id)));
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));
    const send = appendDirectMessage(auth(p.Dee), g, { transactionId: randomUUID(), content: envelope(p.Dee) });
    await new Promise((r) => setTimeout(r, 300));
    release();
    await removal;
    await expect(send).rejects.toThrow("not found");
  });

  it("history from before joining stays out of reach for attachments and reports", async () => {
    const [file] = await db.insert(attachment).values({ uploaderId: p.Owner.id, key: `attachments/${randomUUID()}.bin`, contentType: "application/octet-stream", size: 1, width: 0, height: 0 }).returning({ id: attachment.id });
    const old = await appendDirectMessage(auth(p.Owner), g, { transactionId: randomUUID(), content: envelope(p.Owner), attachments: [file.id] });
    await new Promise((r) => setTimeout(r, 20));
    // Ann was there; Dee (removed above) is added again only after the message.
    await expect(directAttachmentFor(p.Ann.id, file.id)).resolves.toBeTruthy();
    await addGroupMembers(p.Owner.id, g, [p.Dee.id]);
    await expect(directAttachmentFor(p.Dee.id, file.id)).rejects.toThrow("not found");
    await expect(reportDirectMessage(p.Dee.id, { id: old.id, reason: "Not mine to see", excerpt: null })).rejects.toThrow("not found");
  });
});

describe("group size matches the eight-device call bound", () => {
  it("creates a group of exactly eight, refuses nine, and refuses adding a ninth", async () => {
    expect(DM_GROUP_MAX_MEMBERS).toBe(8);
    const owner = await users.create("Cap owner");
    const friends = await Promise.all(Array.from({ length: 8 }, (_, i) => users.create(`Cap friend ${i}`)));
    for (const id of friends) await befriend(owner, id);
    await expect(createGroupConversation(owner, { members: friends })).rejects.toThrow("at most 8 people");
    const full = await createGroupConversation(owner, { members: friends.slice(0, 7) });
    expect((await listDirectConversations(owner)).find((c) => c.id === full)!.members).toHaveLength(7);
    await expect(addGroupMembers(owner, full, [friends[7]])).rejects.toThrow("at most 8 people");
    const small = await createGroupConversation(owner, { members: friends.slice(0, 6) });
    await addGroupMembers(owner, small, [friends[6]]);
    await expect(addGroupMembers(owner, small, [friends[7]])).rejects.toThrow("at most 8 people");
    expect(await db.$count(dmMember, and(eq(dmMember.conversationId, small), sql`${dmMember.leftAt} is null and ${dmMember.removedAt} is null`))).toBe(8);
  });
});
