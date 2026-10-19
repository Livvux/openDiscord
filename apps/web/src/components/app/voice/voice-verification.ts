import type { VoiceCallView } from "@/lib/voice/call-session";

type View = Pick<VoiceCallView, "state" | "keysPrepared" | "roster" | "selfMemberId" | "admittedMemberIds" | "sas" | "generation">;
export type AutomaticVoiceStep = Readonly<{ key: string; memberId: string } & ({ step: "request" } | { step: "accept" | "start" | "accept-sas"; handle: string })>;

/**
 * SAS protocol steps that carry no trust decision, so the UI runs them itself:
 * request (lower member only, once keys are prepared), accept, start and accept-sas.
 * Confirming that the symbols match, admitting, cancelling and the full-audience
 * consent always stay explicit human actions. Each key is meant to be tried once;
 * after a failure the matching manual button remains.
 */
export function automaticVoiceVerificationSteps(view: View): AutomaticVoiceStep[] {
  if (view.state === "ended") return [];
  return view.roster.flatMap((member): AutomaticVoiceStep[] => {
    const memberId = member.memberId;
    if (memberId === view.selfMemberId || view.admittedMemberIds.includes(memberId)) return [];
    const flow = [...view.sas].reverse().find(sas => sas.peer.memberId === memberId && !sas.cancelled);
    if (!flow) return view.keysPrepared && view.selfMemberId < memberId ? [{ key: `${view.generation}:${memberId}:request`, memberId, step: "request" }] : [];
    if (flow.done) return [];
    // A started SAS moves the native request past Ready, so isReady() alone cannot gate accept.
    const step = flow.hasSas ? (!flow.sasAccepted && !flow.weStarted ? "accept-sas" : null) : !flow.ready && !flow.weStarted ? "accept" : flow.ready && flow.weStarted ? "start" : null;
    return step ? [{ key: `${view.generation}:${flow.handle}:${step}`, memberId, handle: flow.handle, step }] : [];
  });
}
