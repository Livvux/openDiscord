import { describe, expect, it } from "vitest";
import { applyResync, mergeMessages } from "@/lib/merge-messages";
import type { MessageView } from "@/server/messages";

const m = (id: string, content = id): MessageView => ({
  id,
  channelId: "c",
  authorId: "a",
  authorName: "A",
  content,
  createdAt: "2026-01-01T00:00:00.000Z",
  editedAt: null,
  attachments: [], mentions: [],
});

describe("mergeMessages", () => {
  it("dedupes by id, prefers incoming, sorts by id", () => {
    expect(mergeMessages([m("02"), m("01")], [m("02", "edited"), m("03")]).map((x) => x.content)).toEqual(["01", "edited", "03"]);
  });
});

describe("applyResync", () => {
  it("takes the page as the whole history when it is complete", () => {
    expect(applyResync({ messages: [m("01"), m("02")], hasMore: true }, { messages: [m("02")], hasMore: false })).toEqual({
      messages: [m("02")],
      hasMore: false,
    });
  });

  it("keeps older local history and drops messages deleted inside the page range", () => {
    const current = { messages: [m("01"), m("02"), m("03"), m("04")], hasMore: true };
    const page = { messages: [m("03"), m("05")], hasMore: true };
    expect(applyResync(current, page).messages.map((x) => x.id)).toEqual(["01", "02", "03", "05"]);
  });

  it("replaces local history when the gap is larger than one page", () => {
    const current = { messages: [m("01"), m("02")], hasMore: false };
    const page = { messages: [m("08"), m("09")], hasMore: true };
    expect(applyResync(current, page)).toEqual({ messages: [m("08"), m("09")], hasMore: true });
  });
});
