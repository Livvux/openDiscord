// Unreachable preparation: no route imports these helpers.
import { voiceJoinAuthSchema, voiceMemberAuthSchema, type VoiceJoinAuth, type VoiceMemberAuth } from "@/lib/voice/contracts";
import { forbidden } from "./errors";
import { PRIVATE_NO_STORE } from "./http";
import { requireUser } from "./session";
import { parse } from "./validation";

export const VOICE_RESPONSE_HEADERS = PRIVATE_NO_STORE;

/** A future handler must apply private,no-store to every success AND error response. */
export function assertVoiceOrigin(request: Request): void {
  const configured = process.env.BETTER_AUTH_URL;
  if (!configured) throw forbidden("Voice is unavailable.");
  const expected = new URL(configured).origin;
  if (request.headers.get("origin") !== expected || request.headers.get("sec-fetch-site") === "cross-site") throw forbidden("Use this instance's application.");
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw forbidden("Send JSON.");
}

export async function requireVoiceJoin(request: Request): Promise<VoiceJoinAuth> {
  assertVoiceOrigin(request);
  const user = await requireUser(request.headers);
  return parse(voiceJoinAuthSchema, { userId: user.id, sessionId: user.sessionId, anchorDeviceId: request.headers.get("x-dm-device"), anchorSecret: request.headers.get("x-dm-device-secret") });
}

export async function requireVoiceMember(request: Request): Promise<VoiceMemberAuth> {
  assertVoiceOrigin(request);
  const user = await requireUser(request.headers);
  return parse(voiceMemberAuthSchema, { userId: user.id, sessionId: user.sessionId, memberId: request.headers.get("x-voice-member"), secret: request.headers.get("x-voice-secret") });
}
