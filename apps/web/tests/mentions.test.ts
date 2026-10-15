import { describe, expect, it } from "vitest";
import { decodeMentions, encodeMentions, mentionQuery, splitMentions } from "@/lib/mentions";
import { parseMentionIds } from "@/server/mentions";

const ann = { id: "u1", name: "Ann" };
const annLee = { id: "u2", name: "Ann Lee" };

describe("mention tokens", () => {
  it("encodes picked names, preferring the longest match, and decodes them back", () => {
    const encoded = encodeMentions("hi @Ann Lee and @Ann, see @Annabel", [ann, annLee]);
    expect(encoded).toBe("hi <@u2> and <@u1>, see @Annabel");
    expect(decodeMentions(encoded, [ann, annLee])).toBe("hi @Ann Lee and @Ann, see @Annabel");
  });

  it("keeps unknown tokens when decoding", () => {
    expect(decodeMentions("<@zz> hi", [ann])).toBe("<@zz> hi");
  });

  it("escapes regex characters in names", () => {
    expect(encodeMentions("@a.b+ ok", [{ id: "x", name: "a.b+" }])).toBe("<@x> ok");
  });

  it("splits content into text and mention parts", () => {
    expect(splitMentions("a <@u1>b<@u2>")).toEqual([
      { type: "text", text: "a " },
      { type: "mention", id: "u1" },
      { type: "text", text: "b" },
      { type: "mention", id: "u2" },
    ]);
  });

  it("parses distinct ids server-side and bounds them", () => {
    expect(parseMentionIds("<@a> <@b> <@a> <@bad id>")).toEqual(["a", "b"]);
    expect(parseMentionIds(Array.from({ length: 30 }, (_, i) => `<@u${i}>`).join(" "))).toHaveLength(20);
  });

  it("finds the query being typed before the caret", () => {
    expect(mentionQuery("hello @an", 9)).toEqual({ query: "an", start: 6 });
    expect(mentionQuery("@", 1)).toEqual({ query: "", start: 0 });
    expect(mentionQuery("mail@example", 12)).toBeNull();
    expect(mentionQuery("@ann done", 9)).toBeNull();
  });
});
