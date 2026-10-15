// Voice channels on a self-hosted LiveKit SFU (docs/DECISIONS.md D8). LiveKit never reads our
// database: we hand out short-lived room tokens after the usual permission checks, and remove people
// from rooms when they lose access (kick, ban, role or channel changes).
import { and, eq } from "drizzle-orm";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { db } from "@/db";
import { channel, user } from "@/db/schema";
import { loadChannelAuthority, requireChannel } from "./access";
import { AppError } from "./errors";
import { has, Permission } from "./permissions";
import { parse, uuid } from "./validation";

const url = process.env.LIVEKIT_URL;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;

/** Voice is optional: without LiveKit settings, voice channels can't be created or joined. */
export const voiceEnabled = Boolean(url && apiKey && apiSecret);
/** Long enough to connect and reconnect; access is re-checked when a new token is requested. */
const TOKEN_TTL_SECONDS = 10 * 60;

/** The server API can live on a private address (compose: http://livekit:7880); defaults to the public URL. */
const apiUrl = process.env.LIVEKIT_API_URL || url?.replace(/^ws/, "http");

function rooms(): RoomServiceClient {
  return new RoomServiceClient(apiUrl!, apiKey!, apiSecret!);
}

export interface VoiceJoin {
  url: string;
  token: string;
  canSpeak: boolean;
}

export async function createVoiceToken(userId: string, rawChannelId: unknown): Promise<VoiceJoin> {
  if (!voiceEnabled) throw new AppError("not_found", "Voice isn't set up on this instance.");
  const channelId = parse(uuid, rawChannelId);
  const { channel: ch, authority } = await requireChannel(db, channelId, userId, Permission.Connect);
  if (ch.kind !== "voice") throw new AppError("invalid", "This isn't a voice channel.");
  const [me] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
  const canSpeak = has(authority, Permission.Speak);
  const at = new AccessToken(apiKey, apiSecret, { identity: userId, name: me?.name, ttl: TOKEN_TTL_SECONDS });
  at.addGrant({
    room: ch.id,
    roomJoin: true,
    canSubscribe: true,
    canPublish: canSpeak,
    canPublishSources: canSpeak ? [TrackSource.MICROPHONE] : [],
    // No data channel: chat stays in text channels, where it is moderated.
    canPublishData: false,
  });
  return { url: url!, token: await at.toJwt(), canSpeak };
}

export interface VoiceParticipant {
  id: string;
  name: string;
}

/** Who is in a voice channel right now (for people who can see it). */
export async function listVoiceParticipants(userId: string, rawChannelId: unknown): Promise<VoiceParticipant[]> {
  const channelId = parse(uuid, rawChannelId);
  const { channel: ch } = await requireChannel(db, channelId, userId);
  if (!voiceEnabled || ch.kind !== "voice") return [];
  const participants = await rooms().listParticipants(ch.id).catch(() => []);
  return participants.map((p) => ({ id: p.identity, name: p.name || "Member" }));
}

/**
 * Re-checks everyone in the community's voice rooms: people who can no longer connect are removed,
 * people who can no longer speak are muted. Best effort, so moderation never fails because LiveKit is down.
 */
export async function reconcileVoice(communityId: string): Promise<void> {
  if (!voiceEnabled) return;
  const voiceChannels = await db
    .select({ id: channel.id })
    .from(channel)
    .where(and(eq(channel.communityId, communityId), eq(channel.kind, "voice")));
  const client = rooms();
  for (const ch of voiceChannels) {
    const participants = await client.listParticipants(ch.id).catch(() => []);
    for (const p of participants) {
      const access = await loadChannelAuthority(db, ch.id, p.identity).catch(() => null);
      if (!access || !has(access.authority, Permission.Connect)) {
        await client.removeParticipant(ch.id, p.identity).catch(() => {});
      } else if (!has(access.authority, Permission.Speak) && p.permission?.canPublish) {
        await client
          .updateParticipant(ch.id, p.identity, { permission: { canSubscribe: true, canPublish: false, canPublishData: false } })
          .catch(() => {});
      }
    }
  }
}

/** Closes a deleted voice channel's room. */
export async function closeVoiceRoom(channelId: string): Promise<void> {
  if (voiceEnabled) await rooms().deleteRoom(channelId).catch(() => {});
}

/** Fire-and-forget wrapper for mutations: log, never throw. */
export function afterAccessChange(communityId: string): void {
  void reconcileVoice(communityId).catch((error: unknown) => console.error("[voice] reconcile failed", error));
}
