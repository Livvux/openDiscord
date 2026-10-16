import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { VoiceCallSessionError, type VoiceCallView } from "@/lib/voice/call-session";
import { mountCurrentVoiceAudio, voiceStatus } from "@/components/app/voice/voice-provider";
import { canPrepareVoiceAudience, prepareCurrentVoiceAudience } from "@/components/app/voice/voice-audience";

// Executes the exact mount function delegated to by the provider's passive effect.
// Session authority is controlled independently, as it can change between render and effect.
const container = {} as HTMLElement;
describe("Voice provider passive audio ownership", () => {
  it.each(["closed", "replaced", "auth-mismatch"])("does not attach or throw when %s precedes the audio effect", reason => {
    const mountAudio = vi.fn(() => () => {});
    const session = { getSnapshot: () => ({ state: reason === "closed" ? "ended" as const : "verifying" as const }), mountAudio };
    expect(() => mountCurrentVoiceAudio(session, () => reason === "closed", container)).not.toThrow();
    expect(mountAudio).not.toHaveBeenCalled();
  });
  it.each(["ended", "lease-expired", "binding-changed"] as const)("absorbs an authoritative %s fence occurring during mount without an attachment", code => {
    const mountAudio = vi.fn(() => { throw new VoiceCallSessionError(code); });
    const session = { getSnapshot: () => ({ state: "verifying" as const }), mountAudio };
    expect(mountCurrentVoiceAudio(session, () => true, container)).toBeUndefined();
    expect(mountAudio).toHaveBeenCalledOnce();
  });
  it("preserves the successful idempotent detach and refuses to remount a replaced session", () => {
    let attached = 0;
    const detach = () => { attached = 0; };
    const mountAudio = vi.fn(() => { attached++; return detach; });
    const session = { getSnapshot: () => ({ state: "verifying" as const }), mountAudio };
    const cleanup = mountCurrentVoiceAudio(session, () => true, container);
    expect(attached).toBe(1); expect(cleanup).toBe(detach);
    cleanup?.(); cleanup?.(); expect(attached).toBe(0);
    expect(mountCurrentVoiceAudio(session, () => false, container)).toBeUndefined();
    expect(mountAudio).toHaveBeenCalledOnce();
  });
  it("does not hide an unexpected mount defect", () => {
    const session = { getSnapshot: () => ({ state: "verifying" as const }), mountAudio: () => { throw new Error("unexpected adapter defect"); } };
    expect(() => mountCurrentVoiceAudio(session, () => true, container)).toThrow("unexpected adapter defect");
  });
});

function audienceView(state: VoiceCallView["state"] = "waiting"): VoiceCallView {
  const member = (memberId: string) => ({ memberId, userId: memberId, anchorDeviceId: memberId, voiceDeviceId: memberId, joinNonce: memberId, voiceUserId: memberId, participantIdentity: memberId, displayName: memberId, state: "active" as const });
  return { state, keysPrepared: true, roster: [member("self"), member("peer")], selfMemberId: "self", admittedMemberIds: ["peer"], sas: [], generation: 1, fenceRevision: 0, localConsentPending: false,
    media: { mediaState: "none", sources: [], microphone: false, camera: false, screenShare: false, audioBlocked: false, tiles: [] } };
}
describe("Voice audience preparation presentation boundary", () => {
  it.each(["verifying", "waiting", "retry-required"] as const)("dispatches once in eligible %s without yielding after the latest snapshot", async state => {
    const view = audienceView(state), order: string[] = [];
    const call = { getSnapshot: () => { order.push("snapshot"); return view; }, confirmFullRoster: vi.fn(async () => { order.push("dispatch"); }) };
    expect(canPrepareVoiceAudience(view, false)).toBe(true);
    const result = prepareCurrentVoiceAudience(call);
    expect(order).toEqual(["snapshot", "dispatch"]);
    await result; expect(call.confirmFullRoster).toHaveBeenCalledOnce();
  });
  it.each(["negotiating", "agreed", "ended"] as const)("rejects %s at both render and dispatch boundaries without closing the call", state => {
    const view = audienceView(state), call = { getSnapshot: () => view, confirmFullRoster: vi.fn(async () => {}), close: vi.fn() };
    expect(canPrepareVoiceAudience(view, false)).toBe(false);
    expect(() => prepareCurrentVoiceAudience(call)).toThrow(expect.objectContaining({ code: "not-ready" }));
    expect(call.confirmFullRoster).not.toHaveBeenCalled(); expect(call.close).not.toHaveBeenCalled();
  });
  it("refuses a stale rendered waiting action once the current snapshot is negotiating", () => {
    let latest = audienceView();
    const call = { getSnapshot: () => latest, confirmFullRoster: vi.fn(async () => {}) };
    expect(canPrepareVoiceAudience(latest, false)).toBe(true);
    latest = audienceView("negotiating");
    expect(() => prepareCurrentVoiceAudience(call)).toThrow(expect.objectContaining({ code: "not-ready" }));
    expect(call.confirmFullRoster).not.toHaveBeenCalled();
  });
  it("keeps all prerequisite and media checks at render and latest dispatch", () => {
    const view = audienceView();
    expect(canPrepareVoiceAudience(null, false)).toBe(false);
    expect(canPrepareVoiceAudience(view, true)).toBe(false);
    const refused: VoiceCallView[] = [{ ...view, keysPrepared: false }, { ...view, admittedMemberIds: [] }, ...(["keying", "ready"] as const).map(mediaState => ({ ...view, media: { ...view.media, mediaState } }))];
    for (const latest of refused) {
      const call = { getSnapshot: () => latest, confirmFullRoster: vi.fn(async () => {}) };
      expect(canPrepareVoiceAudience(latest, false)).toBe(false);
      expect(() => prepareCurrentVoiceAudience(call)).toThrow(expect.objectContaining({ code: "not-ready" }));
      expect(call.confirmFullRoster).not.toHaveBeenCalled();
    }
  });
  it("wires VoiceRoom disabled state and provider dispatch to the production helpers", () => {
    const room = readFileSync(new URL("../src/components/app/voice/voice-room.tsx", import.meta.url), "utf8");
    const provider = readFileSync(new URL("../src/components/app/voice/voice-provider.tsx", import.meta.url), "utf8");
    expect(room).toContain("disabled={!canPrepareVoiceAudience(view, voice.busy)}");
    expect(provider).toContain("confirmFullRoster: () => run(prepareCurrentVoiceAudience)");
    expect(provider).not.toContain("call.confirmFullRoster()");
  });
  it("presents actual thin consent-pending separately from setup waiting and later phases", () => {
    const view = audienceView();
    expect(voiceStatus(view, false)).toBe("Waiting for participant setup and audience consent.");
    expect(voiceStatus({ ...view, localConsentPending: true }, false)).toBe("Waiting for your full audience consent.");
    expect(voiceStatus({ ...view, state: "negotiating", localConsentPending: true }, false)).toBe("Agreeing the full audience…");
    expect(voiceStatus({ ...view, state: "retry-required", localConsentPending: true }, false)).toBe("Audience attempt expired. Review everyone and retry.");
  });
});
