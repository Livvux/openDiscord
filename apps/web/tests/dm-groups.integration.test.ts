import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { dmConversation, friendship, session, user } from "@/db/schema";
import { eq } from "drizzle-orm";
import { blockUser } from "@/server/blocks";
import { appendDirectMessage, createDirectConversation, exportDirectData, handleCryptoRequest, listDirectConversations, listDirectMessages, listDmDevices, markDirectConversationRead, registerDmDevice } from "@/server/direct-messages";
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

beforeAll(async () => {
  for (const name of ["Gina", "Hugo", "Ivy", "Jon", "Kim", "Stranger"]) {
    const id = await users.create(`Group ${name}`);
    const person = { id, device: randomUUID(), session: randomUUID(), secret: randomBytes(32).toString("hex") };
    people[name] = person;
    await db.insert(session).values({ id: person.session, userId: id, token: randomUUID(), createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
    await registerDmDevice(id, person.session, { id: person.device, secret: person.secret, name: `${name} browser` });
    await handleCryptoRequest(auth(person), { kind: "upload", body: { device_keys: { user_id: matrix(id), device_id: person.device, algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"], keys: { [`curve25519:${person.device}`]: envelope(person).sender_key, [`ed25519:${person.device}`]: "e".repeat(43) }, signatures: {} } } });
  }
  // Gina is friends with everyone but Stranger; the others don't know each other.
  for (const name of ["Hugo", "Ivy", "Jon", "Kim"]) await befriend(people.Gina.id, people[name].id);
});
afterAll(() => users.cleanup());

describe("encrypted group conversations", () => {
  it("creates a group of 3–10 from the creator's friends only", async () => {
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
    const { Gina, Jon, Kim } = people;
    await blockUser(Jon.id, Kim.id);
    expect((await listDirectConversations(Jon.id)).find((c) => c.id === group)!.members.find((m) => m.id === Kim.id)).toMatchObject({ blocked: true });
    await expect(handleCryptoRequest(auth(Jon), { kind: "query", body: { device_keys: { [matrix(Kim.id)]: [] } } })).rejects.toThrow("not found");
    await leaveGroup(Gina.id, group);
    // The longest-standing remaining member may now manage the group.
    await removeGroupMember(Jon.id, group, Kim.id);
    expect(JSON.stringify(await exportDirectData(Jon.id))).toContain(group);
    // Deleting the creator's account keeps the group for the others.
    const other = await createGroupConversation(Gina.id, { members: [Jon.id, Kim.id] });
    await db.delete(user).where(eq(user.id, Gina.id));
    expect((await listDirectConversations(Kim.id)).find((c) => c.id === other)!.members.map((m) => m.id)).toEqual([Jon.id]);
    await db.delete(user).where(eq(user.id, Jon.id));
    // The last member is gone, so is the group and its ciphertext.
    expect(await db.select().from(dmConversation).where(eq(dmConversation.id, group))).toEqual([]);
    await leaveGroup(Kim.id, other);
    expect(await db.select().from(dmConversation).where(eq(dmConversation.id, other))).toEqual([]);
  });
});
