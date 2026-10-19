import { describe, expect, it } from "vitest";
import { applyCallNotice, dismissRing, expireRings, RING_TIMEOUT_MS, type Ring } from "@/components/app/voice/dm-call-ring";

const ringing = { conversationId: "c1", state: "ringing" as const, callerId: "u1", callerName: "Ada" };
const ended = { conversationId: "c1", state: "ended" as const, callerId: null, callerName: null };

describe("direct-message call ringing state", () => {
  it("rings once per conversation and keeps the caller", () => {
    const once = applyCallNotice([], ringing, 1000);
    expect(once).toEqual([{ conversationId: "c1", callerName: "Ada", state: "ringing", since: 1000 }]);
    expect(applyCallNotice(once, { ...ringing, callerName: "Ada" }, 2000)).toEqual([{ conversationId: "c1", callerName: "Ada", state: "ringing", since: 2000 }]);
    expect(applyCallNotice(once, { ...ringing, conversationId: "c2" }, 2000)).toHaveLength(2);
  });
  it("never rings for the call this browser is already in", () => {
    expect(applyCallNotice([], ringing, 1000, "c1")).toEqual([]);
  });
  it("turns an unanswered ring into a missed call when the call ends", () => {
    const missed = applyCallNotice(applyCallNotice([], ringing, 1000), ended, 3000);
    expect(missed).toEqual([{ conversationId: "c1", callerName: "Ada", state: "missed", since: 1000 }]);
    // An end without a ring (a call this person never heard about) adds nothing.
    expect(applyCallNotice([], ended, 3000)).toEqual([]);
  });
  it("marks a ring as missed after the timeout and dismisses explicitly", () => {
    const rings: Ring[] = applyCallNotice([], ringing, 1000);
    expect(expireRings(rings, 1000 + RING_TIMEOUT_MS - 1)).toBe(rings);
    expect(expireRings(rings, 1000 + RING_TIMEOUT_MS)[0].state).toBe("missed");
    expect(dismissRing(rings, "c1")).toEqual([]);
    expect(rings).toHaveLength(1);
  });
  it("ignores malformed notices", () => {
    expect(applyCallNotice([], { conversationId: "", state: "ringing", callerId: null, callerName: null }, 1)).toEqual([]);
    expect(applyCallNotice([], { conversationId: "c1", state: "bogus", callerId: null, callerName: null } as never, 1)).toEqual([]);
  });
});
