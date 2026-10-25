import { describe, expect, it } from "vitest";
import { ringingBack, voiceSoundsFor } from "@/components/app/voice/voice-sounds";

type Media = { mediaState: "none" | "keying" | "ready" | "ended"; microphone: boolean };
const view = (members: string[], media: Partial<Media> = {}, state: "waiting" | "ended" = "waiting") =>
  ({ state, selfMemberId: "me", roster: ["me", ...members].map((memberId) => ({ memberId })), media: { mediaState: "ready", microphone: false, ...media } }) as unknown as Parameters<typeof voiceSoundsFor>[0];

describe("voiceSoundsFor", () => {
  it("treats the first view as a baseline", () => expect(voiceSoundsFor(null, view(["a"]))).toEqual([]));
  it("plays join once media is ready", () => expect(voiceSoundsFor(view([], { mediaState: "keying" }), view([]))).toEqual(["join"]));
  it("plays peer join and leave", () => {
    expect(voiceSoundsFor(view([]), view(["a"]))).toEqual(["peerJoin"]);
    expect(voiceSoundsFor(view(["a", "b"]), view(["a"]))).toEqual(["peerLeave"]);
  });
  it("plays mic toggles", () => {
    expect(voiceSoundsFor(view([]), view([], { microphone: true }))).toEqual(["micOn"]);
    expect(voiceSoundsFor(view([], { microphone: true }), view([]))).toEqual(["micOff"]);
  });
  it("plays leave when the call ends or is closed", () => {
    expect(voiceSoundsFor(view(["a"]), view(["a"], {}, "ended"))).toEqual(["leave"]);
    expect(voiceSoundsFor(view(["a"]), null)).toEqual(["leave"]);
    expect(voiceSoundsFor(null, null)).toEqual([]);
  });
});

describe("ringingBack", () => {
  it("rings only in an active direct call with nobody else there", () => {
    expect(ringingBack(true, view([]))).toBe(true);
    expect(ringingBack(true, view(["a"]))).toBe(false);
    expect(ringingBack(false, view([]))).toBe(false);
    expect(ringingBack(true, view([], {}, "ended"))).toBe(false);
  });
});
