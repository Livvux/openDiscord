import type { AppSound } from "@/lib/sounds/app-sounds";
import type { VoiceCallView } from "@/lib/voice/call-session";

type View = Pick<VoiceCallView, "state" | "roster" | "selfMemberId"> & { media: Pick<VoiceCallView["media"], "mediaState" | "microphone"> };

const active = (view: View | null): view is View => !!view && view.state !== "ended";
const others = (view: View) => view.roster.filter((member) => member.memberId !== view.selfMemberId).length;

/** Cues for one call view change. The first view of a call is the baseline: people already there don't "join". */
export function voiceSoundsFor(previous: View | null, next: View | null): AppSound[] {
  if (!active(previous)) return [];
  if (!active(next)) return ["leave"];
  const sounds: AppSound[] = [];
  if (previous.media.mediaState !== "ready" && next.media.mediaState === "ready") sounds.push("join");
  const before = others(previous), after = others(next);
  if (after > before) sounds.push("peerJoin");
  else if (after < before) sounds.push("peerLeave");
  if (previous.media.mediaState === "ready" && next.media.mediaState === "ready" && previous.media.microphone !== next.media.microphone) sounds.push(next.media.microphone ? "micOn" : "micOff");
  return sounds;
}

/** Caller side of a direct call: ring back until someone else is in the room. */
export const ringingBack = (dm: boolean, view: View | null): boolean => dm && active(view) && others(view) === 0;
