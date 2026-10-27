import { EmojiText } from "@/components/app/emoji-text";
import { Spoiler } from "@/components/app/spoiler";
import { ASSET_TOKEN_SOURCE, assetText } from "./community-assets";
// A small, safe Markdown subset for chat (Discord's flavour): code blocks, quotes, headings, subtext, lists,
// inline code, bold, italic, underline, strikethrough, spoilers,
// autolinked http(s) URLs and mention tokens. Output is React elements only, never raw HTML, so message
// content can't inject markup; links are limited to http(s) and open without referrer or opener.
import { Fragment, type ReactNode } from "react";

export type AssetRenderer = (token: string, key: string) => ReactNode;
export type MentionRenderer = (id: string, key: string) => ReactNode;

const FENCE = /```(?:[\w+-]{1,20}\n)?([\s\S]*?)```/g;
const INLINE_BASE =
  /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(~~[^~\n]+?~~)|((?<![\w*])\*(?![\s*])[^*\n]*?[^\s*]\*(?![\w*])|(?<![\w_])_(?![\s_])[^_\n]*?[^\s_]_(?![\w_]))|(<@[A-Za-z0-9_-]{1,64}>)|(https?:\/\/[^\s<>]+)|(\|\|[^|\n]+?\|\|)|((?<![\w_])__(?!\s)[^_\n]+?__(?![\w_]))/g;

const INLINE = new RegExp(`${INLINE_BASE.source}|(${ASSET_TOKEN_SOURCE})`, "g");

function inline(text: string, mention: MentionRenderer, prefix: string, asset: AssetRenderer): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(<EmojiText key={`${prefix}-text-${m.index}`} text={text.slice(last, m.index)} />);
    const key = `${prefix}-${i++}`;
    const [token, code, bold, strike, italic, mentionToken, url, spoiler, underline, assetToken] = m;
    if (code) out.push(<code key={key} className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.85em]">{code.slice(1, -1)}</code>);
    else if (bold) out.push(<strong key={key}>{inline(bold.slice(2, -2), mention, key, asset)}</strong>);
    else if (strike) out.push(<s key={key}>{inline(strike.slice(2, -2), mention, key, asset)}</s>);
    else if (spoiler) out.push(<Spoiler key={key}>{inline(spoiler.slice(2, -2), mention, key, asset)}</Spoiler>);
    else if (underline) out.push(<u key={key}>{inline(underline.slice(2, -2), mention, key, asset)}</u>);
    else if (italic) out.push(<em key={key}>{inline(italic.slice(1, -1), mention, key, asset)}</em>);
    else if (mentionToken) out.push(mention(mentionToken.slice(2, -1), key));
    else if (url) {
      // Trailing punctuation belongs to the sentence; a closing parenthesis only if it has no partner in the URL.
      let end = url.length;
      let unmatched = (url.match(/\)/g)?.length ?? 0) - (url.match(/\(/g)?.length ?? 0);
      while (end > 0) {
        const c = url[end - 1];
        if (c === ")" && unmatched > 0) unmatched--;
        else if (!/[.,;:!?'"\]]/.test(c)) break;
        end--;
      }
      const href = url.slice(0, end);
      if (href.length <= url.indexOf("//") + 2) {
        out.push(token);
        last = m.index + token.length;
        continue;
      }
      out.push(
        <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow ugc" className="text-sky-300 underline underline-offset-2 hover:text-sky-200">
          {href}
        </a>,
        url.slice(end),
      );
    } else if (assetToken) out.push(asset(assetToken, key));
    else out.push(token);
    last = m.index + token.length;
  }
  if (last < text.length) out.push(<EmojiText key={`${prefix}-text-end`} text={text.slice(last)} />);
  return out;
}

const HEADING = /^(#{1,3}) +(?=\S)/;
const SUBTEXT = /^-# +(?=\S)/;
const BULLET = /^ *[-*] +(?=\S)/;
const NUMBERED = /^ *\d{1,3}\. +(?=\S)/;
const QUOTE = /^> ?/;
const HEADING_CLASS = ["", "text-2xl", "text-xl", "text-base"];

/** Lines grouped into Discord's blocks: quotes, headings, subtext, lists, and plain text. */
function blocks(text: string, mention: MentionRenderer, prefix: string, asset: AssetRenderer): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  const run = (start: number, test: RegExp) => {
    const taken: string[] = [];
    for (let j = start; j < lines.length && test.test(lines[j]); j++) taken.push(lines[j].replace(test, ""));
    return taken;
  };
  for (let i = 0; i < lines.length; ) {
    const key = `${prefix}-${i}`;
    const line = lines[i];
    const heading = line.match(HEADING);
    if (QUOTE.test(line)) {
      const quoted = run(i, QUOTE);
      i += quoted.length;
      out.push(
        <blockquote key={key} className="my-0.5 border-l-4 border-white/20 pl-2 text-zinc-300">
          {blocks(quoted.join("\n"), mention, key, asset)}
        </blockquote>,
      );
    } else if (heading) {
      const level = heading[1].length;
      i++;
      out.push(<span key={key} data-md={`h${level}`} className={`mt-2 mb-1 block leading-tight font-bold ${HEADING_CLASS[level]}`}>{inline(line.replace(HEADING, ""), mention, key, asset)}</span>);
    } else if (SUBTEXT.test(line)) {
      i++;
      out.push(<span key={key} data-md="subtext" className="block text-xs text-muted-foreground">{inline(line.replace(SUBTEXT, ""), mention, key, asset)}</span>);
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const numbered = NUMBERED.test(line);
      const items = run(i, numbered ? NUMBERED : BULLET);
      i += items.length;
      const List = numbered ? "ol" : "ul";
      out.push(
        <List key={key} className={`my-0.5 pl-6 ${numbered ? "list-decimal" : "list-disc"}`}>
          {items.map((item, n) => <li key={n}>{inline(item, mention, `${key}-${n}`, asset)}</li>)}
        </List>,
      );
    } else {
      const plain: string[] = [];
      while (i < lines.length && ![QUOTE, HEADING, SUBTEXT, BULLET, NUMBERED].some((r) => r.test(lines[i]))) plain.push(lines[i++]);
      out.push(<Fragment key={key}>{inline(plain.join("\n"), mention, key, asset)}</Fragment>);
    }
  }
  return out;
}

export function renderMarkdown(content: string, mention: MentionRenderer, asset: AssetRenderer = (token) => assetText(token)): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of content.matchAll(FENCE)) {
    if (m.index > last) out.push(...blocks(content.slice(last, m.index).replace(/\n$/, ""), mention, `t${i}`, asset));
    out.push(
      <pre key={`c${i}`} className="my-1 overflow-x-auto rounded-md bg-black/40 p-2 font-mono text-[0.85em] whitespace-pre text-zinc-200">
        <code>{m[1].replace(/\n$/, "")}</code>
      </pre>,
    );
    last = m.index + m[0].length;
    i++;
  }
  if (last < content.length) out.push(...blocks(content.slice(last).replace(/^\n/, ""), mention, `t${i}`, asset));
  return out;
}
