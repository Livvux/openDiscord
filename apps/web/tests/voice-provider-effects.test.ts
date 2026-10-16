import { describe, expect, it, vi } from "vitest";
import { VoiceCallSessionError } from "@/lib/voice/call-session";
import { mountCurrentVoiceAudio } from "@/components/app/voice/voice-provider";

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
