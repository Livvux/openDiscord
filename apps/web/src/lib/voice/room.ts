import { z } from "zod";

const canonicalUuid = z.uuid().refine(value => value === value.toLowerCase());
const roomBinding = z.object({ channelId: canonicalUuid, callId: canonicalUuid, generation: z.number().int().positive().safe() });
export function voiceRoomName(binding: z.infer<typeof roomBinding>): string {
  const value = roomBinding.parse(binding);
  return `voice:${value.channelId}:${value.callId}:${value.generation}`;
}

/** Room scope segment: the channel, or for a direct-message call its own random call ID, so the SFU never learns a conversation ID. */
export const voiceRoomScope = (call: { channelId?: string | null; callId: string }) => call.channelId ?? call.callId;

/** Whole namespace segments only; callers must separately prove instance ownership. */
export function parseVoiceRoomName(name: string): z.infer<typeof roomBinding> | null {
  const parts = name.split(":");
  if (parts.length !== 4 || parts[0] !== "voice" || !/^[1-9][0-9]*$/.test(parts[3])) return null;
  const parsed = roomBinding.safeParse({ channelId: parts[1], callId: parts[2], generation: Number(parts[3]) });
  return parsed.success && voiceRoomName(parsed.data) === name ? parsed.data : null;
}
