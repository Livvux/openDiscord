import emojiRegex from "emoji-regex";
import assets from "./twemoji-assets.json";

const available = new Set(assets);
export const TWEMOJI_BASE = "/twemoji/17.0.3/svg";

export function twemojiUrl(unified: string): string {
  const id = unified.toLowerCase().replace(/(^|-)0+(?=[0-9a-f])/g, "$1");
  const filename = available.has(id) ? id : id.replace(/-fe0f/g, "");
  return `${TWEMOJI_BASE}/${filename}.svg`;
}

export function emojiUnified(emoji: string): string {
  return Array.from(emoji, (char) => char.codePointAt(0)!.toString(16)).join("-");
}

/** Only complete emoji sequences with a bundled graphic are selectable as reactions. */
export function isUnicodeEmoji(value: string): boolean {
  const match = emojiRegex().exec(value);
  return match?.[0] === value && available.has(twemojiUrl(emojiUnified(value)).split("/").at(-1)!.slice(0, -4));
}

export function emojiMatches(text: string) {
  return text.matchAll(emojiRegex());
}

export function insertEmoji(text: string, insertion: string, start: number, end: number, maxLength: number) {
  const value = text.slice(0, start) + insertion + text.slice(end);
  return value.length <= maxLength ? { value, caret: start + insertion.length } : null;
}
