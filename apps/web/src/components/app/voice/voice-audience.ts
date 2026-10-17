import { VoiceCallSessionError, type VoiceCallView } from "@/lib/voice/call-session";

type AudienceView = Pick<VoiceCallView, "state" | "keysPrepared" | "roster" | "selfMemberId" | "admittedMemberIds" | "media">;

export function canPrepareVoiceAudience(view: AudienceView | null, busy: boolean): boolean {
  return !!view && !busy && ["verifying", "waiting", "retry-required"].includes(view.state)
    && view.keysPrepared && view.media.mediaState !== "keying" && view.media.mediaState !== "ready"
    && view.roster.every(member => member.memberId === view.selfMemberId || view.admittedMemberIds.includes(member.memberId));
}

/** Rendered consent can be stale; decide again immediately before the public call. */
export function prepareCurrentVoiceAudience(call: { getSnapshot(): AudienceView; confirmFullRoster(): Promise<void> }): Promise<void> {
  if (!canPrepareVoiceAudience(call.getSnapshot(), false)) throw new VoiceCallSessionError("not-ready");
  return call.confirmFullRoster();
}
