import { z } from "zod";
import { unstable_rethrow } from "next/navigation";
import { voiceJoinSchema, voiceBindingSchema, voiceCryptoInputSchema } from "@/lib/voice/contracts";
import { joinVoiceControl, heartbeatVoiceControl, leaveVoiceControl, handleVoiceCrypto } from "./voice-control";
import { createBoundVoiceToken } from "./voice";
import { voiceJoinAuthSchema, voiceMemberAuthSchema, type VoiceJoinAuth, type VoiceMemberAuth } from "@/lib/voice/contracts";
import { AppError, forbidden, HTTP_STATUS } from "./errors";
import { PRIVATE_NO_STORE, readJsonBody } from "./http";
import { requireUser } from "./session";
import { parse } from "./validation";

export const VOICE_RESPONSE_HEADERS = PRIVATE_NO_STORE;

/** Voice control accepts JSON only from this instance's exact browser origin. */
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

// The native body is bounded again by the service. This allowance covers action/binding IDs
// (each schema-bounded), not a second unbounded payload.
export const VOICE_HTTP_REQUEST_BYTES = 65_536 + 4096;
export const voiceHttpRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("join"), input: voiceJoinSchema }).strict(),
  z.object({ action: z.literal("heartbeat"), input: voiceBindingSchema }).strict(),
  z.object({ action: z.literal("leave"), input: voiceBindingSchema }).strict(),
  z.object({ action: z.literal("token"), input: voiceBindingSchema }).strict(),
  z.object({ action: z.literal("crypto"), input: voiceCryptoInputSchema }).strict(),
]);

export async function postVoiceControl(request: Request): Promise<Response> {
  try {
    assertVoiceOrigin(request);
    const body = parse(voiceHttpRequestSchema, await readJsonBody(request, VOICE_HTTP_REQUEST_BYTES));
    if (body.action === "join") return Response.json(await joinVoiceControl(await requireVoiceJoin(request), body.input), { headers: VOICE_RESPONSE_HEADERS });
    const auth = await requireVoiceMember(request);
    let result: unknown;
    switch (body.action) {
      case "heartbeat": result = await heartbeatVoiceControl(auth, body.input); break;
      case "leave": result = await leaveVoiceControl(auth, body.input); break;
      case "token": result = await createBoundVoiceToken(auth, body.input); break;
      case "crypto": result = await handleVoiceCrypto(auth, body.input); break;
    }
    return Response.json(result, { headers: VOICE_RESPONSE_HEADERS });
  } catch (error) {
    unstable_rethrow(error);
    // Deliberately do not log unexpected errors: native payloads and bearer material can be
    // attached to SDK/database errors. The stable code is sufficient for the client policy.
    return Response.json({ code: error instanceof AppError ? error.code : "internal" }, { status: error instanceof AppError ? HTTP_STATUS[error.code] : 500, headers: VOICE_RESPONSE_HEADERS });
  }
}

export function denyVoiceMethod(): Response {
  return Response.json({ code: "method_not_allowed" }, { status: 405, headers: { ...VOICE_RESPONSE_HEADERS, Allow: "POST" } });
}
