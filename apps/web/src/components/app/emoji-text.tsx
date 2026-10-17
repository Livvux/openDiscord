import { Fragment } from "react";
import { emojiMatches, emojiUnified, isUnicodeEmoji, twemojiUrl } from "@/lib/emoji";

/** Text stays escaped by React; code and link destinations are never parsed as markup. */
export function EmojiText({ text }: { text: string }) {
  const parts = [];
  let end = 0;
  for (const match of emojiMatches(text)) {
    parts.push(text.slice(end, match.index));
    const emoji = match[0];
    parts.push(isUnicodeEmoji(emoji)
      // Static, locally bundled SVGs need neither optimization nor runtime image fetching code.
      // eslint-disable-next-line @next/next/no-img-element
      ? <img key={match.index} src={twemojiUrl(emojiUnified(emoji))} alt={emoji} draggable={false} loading="lazy" width={20} height={20} className="inline-block size-[1.25em] align-[-0.2em] object-contain" />
      : <Fragment key={match.index}>{emoji}</Fragment>);
    end = match.index + emoji.length;
  }
  parts.push(text.slice(end));
  return <>{parts}</>;
}
