import { z } from "zod";
import { voiceRoomName } from "./room";
import { VOICE_DOMAIN, VOICE_LIMITS, voiceBindingSchema, voiceCryptoInputSchema, voiceJoinSchema, voiceEventSchema, type VoiceBinding, type VoiceCryptoRequest, voiceDeviceKeysSchema, voiceSignedObjectSchema, voicePrekeySchema } from "./contracts";

const id = z.uuid(), text = z.string().min(1).max(128), timestamp = z.iso.datetime();
const removal = z.object({ callId: id, memberId: id, participantIdentity: text, reason: z.string().max(256) }).strict();
const member = z.object({ memberId: id, userId: text, anchorDeviceId: id, voiceUserId: z.string().max(256), voiceDeviceId: id, joinNonce: id, participantIdentity: text, displayName: z.string().max(256), state: z.enum(["waiting", "active"]) }).strict();
export const voiceHttpSnapshotSchema = z.object({ callId: id, channelId: id, generation: z.number().int().positive(), memberId: id, joinNonce: id, voiceUserId: z.string().max(256), voiceDeviceId: id, participantIdentity: text, leaseExpiresAt: timestamp, serverTime: timestamp, members: z.array(member).min(1).max(VOICE_LIMITS.members), removals: z.array(removal).max(VOICE_LIMITS.members) }).strict().superRefine((snapshot, ctx) => {
  const own = snapshot.members.find(member => member.memberId === snapshot.memberId);
  if (new Set(snapshot.members.map(member => member.memberId)).size !== snapshot.members.length || new Set(snapshot.members.map(member => member.voiceDeviceId)).size !== snapshot.members.length || !own || own.joinNonce !== snapshot.joinNonce || own.voiceUserId !== snapshot.voiceUserId || own.voiceDeviceId !== snapshot.voiceDeviceId || own.participantIdentity !== snapshot.participantIdentity || snapshot.members.some(member => member.voiceUserId !== `@voice_${snapshot.callId}_${member.memberId}:${VOICE_DOMAIN}` || member.participantIdentity !== `v1:${member.memberId}`)) ctx.addIssue({ code: "custom", message: "Invalid voice snapshot binding." });
});
const tokenSchema = z.object({ url: z.url(), token: z.string().min(1).max(16_384), snapshot: voiceHttpSnapshotSchema, roomName: z.string().max(256), participantIdentity: text, sources: z.array(z.enum(["microphone", "camera", "screen_share", "screen_share_audio"])).max(4), canPublishData: z.literal(false), expiresAt: timestamp }).strict().superRefine((grant, ctx) => {
  if (grant.roomName !== voiceRoomName({ channelId: grant.snapshot.channelId, callId: grant.snapshot.callId, generation: grant.snapshot.generation }) || grant.participantIdentity !== grant.snapshot.participantIdentity || Date.parse(grant.expiresAt) > Date.parse(grant.snapshot.leaseExpiresAt) || new Set(grant.sources).size !== grant.sources.length) ctx.addIssue({ code: "custom", message: "Invalid voice media binding." });
});
const errorCodeSchema = z.enum(["unauthorized", "forbidden", "not_found", "invalid", "rate_limited", "conflict", "internal", "method_not_allowed"]);
export type VoiceHttpErrorCode = z.infer<typeof errorCodeSchema> | "protocol" | "network" | "aborted" | "timeout";
export class VoiceHttpError extends Error {
  constructor(readonly code: VoiceHttpErrorCode, readonly status?: number) { super(`Voice HTTP ${code}.`); this.name = "VoiceHttpError"; }
}
// 64 * (8192 native bytes + 256 envelope bytes), commas, plus bounded sync metadata.
const RESPONSE_BYTES = 64 * 8448 + 65 + 4096;
const encoder = new TextEncoder();
export async function readVoiceResponse(response: Response, maxBytes = RESPONSE_BYTES, signal?: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("content-length") ?? "0") > maxBytes) {
    await response.body?.cancel().catch(() => {}); throw new VoiceHttpError("protocol", response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new VoiceHttpError("protocol", response.status);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const decoder = new TextDecoder("utf-8", { fatal: true }); let size = 0, body = "";
  try {
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      size += part.value.byteLength;
      if (size > maxBytes) throw new VoiceHttpError("protocol", response.status);
      body += decoder.decode(part.value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof VoiceHttpError) throw error;
    throw new VoiceHttpError("protocol", response.status);
  } finally { signal?.removeEventListener("abort", cancel); reader.releaseLock(); }
}
const empty = z.object({}).strict(), object = z.record(z.string().max(256), z.unknown());
const signaturesBounded = (value: { signatures?: Record<string, Record<string, string>> }) => !value.signatures || (Object.keys(value.signatures).length <= 2 && Object.values(value.signatures).every(keys => Object.keys(keys).length <= 2));
const deviceKeys = voiceDeviceKeysSchema.refine(value => Object.keys(value.keys).length === 2 && signaturesBounded(value));
const crossKey = voiceSignedObjectSchema.extend({ usage: z.array(z.enum(["master", "self_signing", "user_signing"])).length(1) }).refine(value => Object.keys(value.keys).length === 1 && signaturesBounded(value));
const prekey = voicePrekeySchema.refine(signaturesBounded);
const boundedRecord = <T extends z.ZodType>(schema: T, count: number) => z.record(z.string().min(1).max(256), schema).refine(value => Object.keys(value).length <= count);
const users = <T extends z.ZodType>(schema: T) => boundedRecord(schema, 8);
function cryptoResponse(request: VoiceCryptoRequest, raw: unknown): unknown {
  switch (request.kind) {
    case "ack": case "signing": return empty.parse(raw);
    case "send": case "retire": return z.object({ nativeResponse: empty, disposition: request.kind === "send" ? z.object({ status: z.literal("processed-current"), enqueued: z.literal(1) }).strict() : z.object({ status: z.literal("processed-retired"), enqueued: z.literal(0) }).strict() }).strict().parse(raw);
    case "sync": {
      const result = z.object({ cursor: z.string().regex(/^\d{1,15}$/), events: z.array(z.object({ sender: z.string().max(98), type: z.string().max(100), content: object }).strict()).max(64), oneTimeKeys: z.object({ signed_curve25519: z.number().int().min(0).max(100) }).strict(), unusedFallbackKeys: z.array(z.literal("signed_curve25519")).max(1) }).strict().parse(raw);
      for (const event of result.events) { const schema = voiceEventSchema(event.type); if (!schema || encoder.encode(JSON.stringify(event)).length > 8448) throw new VoiceHttpError("protocol"); schema.parse(event.content); }
      return result;
    }
    case "upload": return z.object({ one_time_key_counts: z.object({ signed_curve25519: z.number().int().min(0).max(100) }).strict() }).strict().parse(raw);
    case "query": return z.object({ device_keys: users(boundedRecord(deviceKeys, 1)), master_keys: users(crossKey), self_signing_keys: users(crossKey), user_signing_keys: users(crossKey), failures: empty }).strict().parse(raw);
    case "claim": return z.object({ one_time_keys: users(boundedRecord(boundedRecord(prekey, 1), 1)), failures: empty }).strict().parse(raw);
    case "signatures": return z.object({ failures: users(boundedRecord(z.object({ errcode: z.literal("M_FORBIDDEN"), error: z.string().max(256) }).strict(), 2)) }).strict().parse(raw);
  }
}
function boundSnapshot(raw: unknown, binding: VoiceBinding) {
  const snapshot = voiceHttpSnapshotSchema.parse(raw);
  if (snapshot.callId !== binding.callId || snapshot.memberId !== binding.memberId || snapshot.joinNonce !== binding.joinNonce || snapshot.generation < binding.expectedGeneration) throw new VoiceHttpError("protocol");
  return snapshot;
}
export function createVoiceHttpClient(options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const fetcher = options.fetch ?? fetch;
  async function call<T>(action: string, input: unknown, headers: Record<string, string>, signal: AbortSignal, validate: (value: unknown) => T): Promise<T> {
    if (signal.aborted) throw new VoiceHttpError("aborted");
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 10_000);
    try {
      const body = JSON.stringify({ action, input });
      if (encoder.encode(body).length > 65_536 + 4096) throw new VoiceHttpError("protocol");
      const response = await fetcher("/api/voice/control", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json", ...headers }, body, signal: controller.signal });
      const raw = await readVoiceResponse(response, response.ok ? RESPONSE_BYTES : 4096, controller.signal);
      if (controller.signal.aborted) throw new VoiceHttpError(timedOut ? "timeout" : "aborted");
      if (!response.ok) {
        const failure = z.object({ code: errorCodeSchema }).strict().safeParse(raw);
        const statuses = { unauthorized: 401, forbidden: 403, not_found: 404, invalid: 400, rate_limited: 429, conflict: 409, internal: 500, method_not_allowed: 405 };
        if (!failure.success || statuses[failure.data.code] !== response.status) throw new VoiceHttpError("protocol", response.status);
        throw new VoiceHttpError(failure.data.code, response.status);
      }
      if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") throw new VoiceHttpError("protocol", response.status);
      return validate(raw);
    } catch (error) {
      if (controller.signal.aborted) throw new VoiceHttpError(timedOut ? "timeout" : "aborted");
      if (error instanceof VoiceHttpError) throw error;
      if (error instanceof z.ZodError) throw new VoiceHttpError("protocol");
      throw new VoiceHttpError("network");
    } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
  }
  const memberHeaders = (binding: VoiceBinding, secret: string) => { voiceBindingSchema.parse(binding); z.string().regex(/^[a-f0-9]{64}$/).parse(secret); return { "x-voice-member": binding.memberId, "x-voice-secret": secret }; };
  return {
    join(input: z.infer<typeof voiceJoinSchema>, anchor: { id: string; secret: string }, signal: AbortSignal) { voiceJoinSchema.parse(input); id.parse(anchor.id); z.string().regex(/^[a-f0-9]{64}$/).parse(anchor.secret); return call("join", input, { "x-dm-device": anchor.id, "x-dm-device-secret": anchor.secret }, signal, value => { const snapshot = voiceHttpSnapshotSchema.parse(value); if (snapshot.channelId !== input.channelId || snapshot.joinNonce !== input.joinNonce || snapshot.voiceDeviceId !== input.voiceDeviceId) throw new VoiceHttpError("protocol"); return snapshot; }); },
    heartbeat(binding: VoiceBinding, secret: string, signal: AbortSignal) { return call("heartbeat", binding, memberHeaders(binding, secret), signal, value => boundSnapshot(value, binding)); },
    leave(binding: VoiceBinding, secret: string, signal: AbortSignal) { return call("leave", binding, memberHeaders(binding, secret), signal, value => z.object({ removals: z.array(removal).max(8) }).strict().parse(value)); },
    token(binding: VoiceBinding, secret: string, signal: AbortSignal) { return call("token", binding, memberHeaders(binding, secret), signal, value => { const grant = tokenSchema.parse(value); boundSnapshot(grant.snapshot, binding); if (grant.snapshot.generation !== binding.expectedGeneration) throw new VoiceHttpError("protocol"); return grant; }); },
    crypto(binding: VoiceBinding, request: VoiceCryptoRequest, secret: string, signal: AbortSignal) { if (encoder.encode(JSON.stringify(request)).length > (request.kind === "upload" || request.kind === "signing" ? VOICE_LIMITS.bootstrapBytes : VOICE_LIMITS.requestBytes)) throw new VoiceHttpError("protocol"); const input = voiceCryptoInputSchema.parse({ ...binding, request }); return call("crypto", input, memberHeaders(binding, secret), signal, value => cryptoResponse(request, value)); },
  };
}
