import { describe, expect, it } from "vitest";
import { typingText } from "@/lib/typing";

describe("typingText", () => {
  it("phrases one, several and many typers like Discord", () => {
    expect(typingText([])).toBeNull();
    expect(typingText(["Ada"])).toEqual({ names: "Ada", verb: " is typing…" });
    expect(typingText(["Ada", "Ben"])).toEqual({ names: "Ada and Ben", verb: " are typing…" });
    expect(typingText(["Ada", "Ben", "Cy"])).toEqual({ names: "Ada, Ben and Cy", verb: " are typing…" });
    expect(typingText(["Ada", "Ben", "Cy", "Di"])).toEqual({ names: "", verb: "Several people are typing…" });
  });
});
