import type { DmAttachment, DmOperation } from "./contracts";
import type { DecryptionDiagnostic } from "./decryption-diagnostics";

type Base = { id: string; own: boolean; createdAt: string; senderId: string };
export type DecryptedDmEvent = Base & ({ body: string; attachments: DmAttachment[]; replyTo?: string; operation?: DmOperation; deleted?: boolean; error?: never; diagnostic?: never } | { body: null; attachments?: never; replyTo?: never; operation?: never; deleted?: never; error: string; diagnostic: DecryptionDiagnostic });
export type PrivateMessageView = DecryptedDmEvent & { edited?: boolean; reactions?: { emoji: Extract<DmOperation, { kind: "reaction" }>["emoji"]; users: string[] }[] };

/** Apply only authenticated, same-conversation events. A peer cannot edit another author's text. */
export function projectDmTimeline(events: DecryptedDmEvent[]): PrivateMessageView[] {
  const messages = new Map<string, PrivateMessageView>();
  for (const event of [...events].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!event.operation) { messages.set(event.id, { ...event }); continue; }
    const operation = event.operation;
    const target = messages.get(operation.target);
    if (!target || target.body === null || target.deleted) continue;
    if (operation.kind === "reaction") {
      const reactions = target.reactions ?? [];
      const users = new Set(reactions.find((r) => r.emoji === operation.emoji)?.users ?? []);
      if (operation.active) users.add(event.senderId); else users.delete(event.senderId);
      target.reactions = [...reactions.filter((r) => r.emoji !== operation.emoji), ...(users.size ? [{ emoji: operation.emoji, users: [...users] }] : [])];
    } else if (target.senderId === event.senderId) {
      if (operation.kind === "edit") { target.body = event.body; target.edited = true; }
      else { target.body = ""; target.attachments = []; target.reactions = []; target.deleted = true; }
    }
  }
  return [...messages.values()];
}

export function searchDmTimeline(messages: PrivateMessageView[], query: string): PrivateMessageView[] {
  const term = query.trim().toLocaleLowerCase();
  return term ? messages.filter((m) => !m.deleted && m.body !== null && (m.body.toLocaleLowerCase().includes(term) || m.attachments.some((a) => a.name.toLocaleLowerCase().includes(term)))) : messages;
}
