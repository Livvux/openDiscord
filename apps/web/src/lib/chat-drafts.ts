/**
 * Unsent composer text per conversation (`channel:<id>`, `thread:<rootId>`, `dm:<conversationId>`).
 * Memory only, by design: never written to browser storage or sent to the server, so DM plaintext
 * stays local and a reload or closed tab drops it. See docs/PRIVACY.md.
 */
export interface ChatDraft<Reply> {
  text: string;
  replyTo: Reply | null;
}

const drafts = new Map<string, ChatDraft<unknown>>();
let owner: string | null = null;

/** Another account in this tab never sees the previous one's drafts. */
function forUser(userId: string) {
  if (owner !== userId) {
    drafts.clear();
    owner = userId;
  }
}

export function readDraft<Reply>(userId: string, scope: string): ChatDraft<Reply> | undefined {
  forUser(userId);
  return drafts.get(scope) as ChatDraft<Reply> | undefined;
}

export function writeDraft<Reply>(userId: string, scope: string, draft: ChatDraft<Reply>) {
  forUser(userId);
  if (!draft.text.trim() && !draft.replyTo) drafts.delete(scope);
  else drafts.set(scope, { text: draft.text, replyTo: draft.replyTo });
}

export function clearDrafts() {
  drafts.clear();
  owner = null;
}
