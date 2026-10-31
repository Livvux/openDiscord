import { describe, expect, it } from "vitest";
import { firstUnseen, intersects, laterId, newestVisibleId } from "@/lib/read-marker";

const view = { top: 100, bottom: 500 };

describe("read-marker geometry", () => {
  it.each([
    [{ top: 0, bottom: 100 }, false], // ends exactly at the top edge
    [{ top: 0, bottom: 101 }, true],
    [{ top: 499, bottom: 600 }, true],
    [{ top: 500, bottom: 600 }, false], // starts exactly at the bottom edge
    [{ top: 0, bottom: 900 }, true], // taller than the viewport
  ])("intersects %o: %s", (row, expected) => {
    expect(intersects(view, row)).toBe(expected);
  });

  it("sees nothing through an empty (display: none) viewport", () => {
    expect(intersects({ top: 0, bottom: 0 }, { top: 0, bottom: 0 })).toBe(false);
    expect(newestVisibleId({ top: 0, bottom: 0 }, [{ id: "a", top: 0, bottom: 0 }])).toBeNull();
  });

  it("picks the newest row on screen, not the newest loaded", () => {
    const rows = [
      { id: "01", top: 50, bottom: 90 },
      { id: "02", top: 120, bottom: 160 },
      { id: "03", top: 450, bottom: 520 },
      { id: "04", top: 600, bottom: 640 },
    ];
    expect(newestVisibleId(view, rows)).toBe("03");
    expect(newestVisibleId(view, [rows[3], rows[0]])).toBeNull();
    // Order doesn't matter: ids decide.
    expect(newestVisibleId(view, [rows[2], rows[1]])).toBe("03");
  });

  it("keeps the later of two ids", () => {
    expect(laterId(null, null)).toBeNull();
    expect(laterId("01", null)).toBe("01");
    expect(laterId(null, "01")).toBe("01");
    expect(laterId("02", "01")).toBe("02");
    expect(laterId("01", "02")).toBe("02");
  });

  it("finds the first unseen message from someone else", () => {
    const messages = [{ id: "01", authorId: "b" }, { id: "02", authorId: "me" }, { id: "03", authorId: "b" }];
    expect(firstUnseen(messages, "me", null)).toBe("01");
    expect(firstUnseen(messages, "me", "01")).toBe("03");
    expect(firstUnseen(messages, "me", "03")).toBeNull();
    expect(firstUnseen([{ id: "04", authorId: "me" }], "me", "01")).toBeNull();
  });
});
