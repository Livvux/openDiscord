export type VoiceRequestCandidate = Readonly<{ count: number; enabled: boolean }>;

/** Runs over the current DOM matches; an absent candidate is an immediate empty snapshot. */
export function voiceRequestCandidate(elements: readonly Pick<Element, "matches" | "getAttribute">[]): VoiceRequestCandidate {
  return { count: Math.min(elements.length, 2), enabled: elements.length === 1 && !elements[0].matches(":disabled") && elements[0].getAttribute("aria-disabled") !== "true" };
}

export async function readVoiceRequestCandidates(first: () => Promise<VoiceRequestCandidate>, second: () => Promise<VoiceRequestCandidate>) {
  const candidates = await Promise.all([first(), second()]);
  const eligible = candidates.flatMap((candidate, index) => candidate.count === 1 && candidate.enabled ? [index] : []);
  const side = candidates.some(candidate => candidate.count > 1) || eligible.length !== 1 ? null : eligible[0];
  return { candidates, side };
}
