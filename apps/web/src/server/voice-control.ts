import { invalid } from "./errors";

/** Unreachable internal draft. Replaced by the reviewed transaction implementation after RED evidence. */
export async function joinVoiceControl(_auth: unknown, _input: unknown): Promise<{ channelId: string; joinNonce: string; voiceDeviceId: string; generation: number; memberId: string; callId: string; voiceUserId: string; participantIdentity: string }> {
  throw invalid("Voice control draft admission is not implemented.");
}
