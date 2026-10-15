// Mentions travel as `<@userId>` tokens; people type and read them as `@Display Name`.

export interface Mention {
  id: string;
  name: string;
}

export type ContentPart = { type: "text"; text: string } | { type: "mention"; id: string };

const TOKEN = /<@([A-Za-z0-9_-]{1,64})>/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Splits stored content into text and mention parts for rendering. */
export function splitMentions(content: string): ContentPart[] {
  const parts: ContentPart[] = [];
  let last = 0;
  for (const m of content.matchAll(TOKEN)) {
    if (m.index > last) parts.push({ type: "text", text: content.slice(last, m.index) });
    parts.push({ type: "mention", id: m[1] });
    last = m.index + m[0].length;
  }
  if (last < content.length) parts.push({ type: "text", text: content.slice(last) });
  return parts;
}

/** `@Name` → `<@id>` for the people picked in the composer. Longer names first, so "@Ann Lee" beats "@Ann". */
export function encodeMentions(text: string, mentions: readonly Mention[]): string {
  return [...mentions]
    .sort((a, b) => b.name.length - a.name.length)
    .reduce((acc, m) => acc.replace(new RegExp(`@${escape(m.name)}(?=$|[\\s.,!?;:)\\]])`, "g"), `<@${m.id}>`), text);
}

/** `<@id>` → `@Name`, for editing. Unknown ids stay as tokens so saving keeps them. */
export function decodeMentions(content: string, mentions: readonly Mention[]): string {
  const names = new Map(mentions.map((m) => [m.id, m.name]));
  return content.replace(TOKEN, (token, id: string) => (names.has(id) ? `@${names.get(id)}` : token));
}

/** The `@query` being typed right before the caret, if any. */
export function mentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const match = /(^|\s)@([^\s@<>]{0,32})$/.exec(text.slice(0, caret));
  return match ? { query: match[2], start: caret - match[2].length - 1 } : null;
}

/** Plain one-line preview: mention tokens become names, then the text is cut to `length`. */
export function excerptOf(content: string, mentions: readonly Mention[], length: number): string {
  const names = new Map(mentions.map((m) => [m.id, m.name]));
  const text = content.replace(TOKEN, (_, id: string) => `@${names.get(id) ?? "member"}`);
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
