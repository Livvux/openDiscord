import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/lib/markdown";

const html = (content: string) =>
  renderToStaticMarkup(createElement(Fragment, null, ...renderMarkdown(content, (id, key) => createElement("b", { key }, `@${id}`))));

describe("markdown subset", () => {
  it("renders inline formatting", () => {
    expect(html("**bold** *it* _it_ ~~gone~~ `x<y`")).toBe(
      '<strong>bold</strong> <em>it</em> <em>it</em> <s>gone</s> <code class="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.85em]">x&lt;y</code>',
    );
  });

  it("never emits raw HTML from content", () => {
    const out = html('<script>alert(1)</script><img src=x onerror="alert(1)">');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });

  it("links only http(s) URLs, without trailing punctuation, safely", () => {
    const out = html("see https://example.com/a?b=1. and javascript:alert(1) and data:text/html,x");
    expect(out).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow ugc"');
    expect(out).not.toContain('href="javascript');
    expect(out).not.toContain('href="data');
  });

  it("doesn't italicise snake_case or arithmetic", () => {
    expect(html("snake_case_name and 2*3*4")).toBe("snake_case_name and 2*3*4");
  });

  it("renders code blocks verbatim and quotes as blockquotes", () => {
    const out = html("before\n```ts\nconst a = **1**;\n```\n> quoted *text*\nafter");
    expect(out).toContain("<pre");
    expect(out).toContain("<code>const a = **1**;</code>");
    expect(out).toContain("<blockquote");
    expect(out).toContain("quoted <em>text</em>");
  });

  it("renders mention tokens through the callback, also inside formatting", () => {
    expect(html("**hi <@u1>**")).toBe("<strong>hi <b>@u1</b></strong>");
  });
});

describe("links in sentences", () => {
  it("keeps balanced parentheses and drops sentence punctuation", () => {
    expect(html("(see https://en.wikipedia.org/wiki/Foo_(bar)).")).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"');
    expect(html("go to https://example.com!")).toContain('href="https://example.com"');
    expect(html("go to https://example.com!")).toMatch(/<\/a>!$/);
    expect(html("just https://")).not.toContain("<a");
  });

  it("stays fast on adversarial input", () => {
    const start = performance.now();
    html(`${"http://".repeat(500)}${".".repeat(500)} ${"```".repeat(400)}`);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
