// Voice channels on a self-hosted LiveKit SFU (docs/DECISIONS.md D8). LiveKit never reads our
// database: we hand out short-lived room tokens after the usual permission checks, and remove people
// from rooms when they lose access (kick, ban, role or channel changes).
import { and, eq } from "drizzle-orm";
import { AccessToken, RoomServiceClient, TokenVerifier, TrackSource } from "livekit-server-sdk";
import { db } from "@/db";
import { channel, user } from "@/db/schema";
import { loadChannelAuthority, requireChannel } from "./access";
import { AppError } from "./errors";
import { has, Permission } from "./permissions";
import { grantBoundVoiceMedia } from "./voice-control";
import type { VoiceMediaSource } from "@/lib/voice/contracts";
import { parse, uuid } from "./validation";

const url = process.env.LIVEKIT_URL;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;

/** Voice is optional: without LiveKit settings, voice channels can't be created or joined. */
export const voiceEnabled = Boolean(url && apiKey && apiSecret);
/**
 * Tokens can't be revoked, so they only need to live long enough to connect: once connected, LiveKit
 * refreshes the session itself, and removals end it. A short lifetime bounds re-joins with a stale token.
 */
const TOKEN_TTL_SECONDS = 60;
/** Reconcile again after a token issued just before an access change has certainly expired. */
const RECHECK_AFTER_MS = (TOKEN_TTL_SECONDS + 5) * 1000;

/** The server API can live on a private address (compose: http://livekit:7880); defaults to the public URL. */
const apiUrl = process.env.LIVEKIT_API_URL || url?.replace(/^ws/, "http");

function rooms(): RoomServiceClient {
  return new RoomServiceClient(apiUrl!, apiKey!, apiSecret!);
}

export interface VoiceJoin {
  url: string;
  token: string;
  canSpeak: boolean;
  canVideo: boolean;
}

/** What a member may publish, from their channel permissions. */
function publishSources(authority: Parameters<typeof has>[0]): TrackSource[] {
  return [
    ...(has(authority, Permission.Speak) ? [TrackSource.MICROPHONE] : []),
    ...(has(authority, Permission.Video) ? [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : []),
  ];
}

export async function createVoiceToken(userId: string, rawChannelId: unknown): Promise<VoiceJoin> {
  if (!voiceEnabled) throw new AppError("not_found", "Voice isn't set up on this instance.");
  const channelId = parse(uuid, rawChannelId);
  const { channel: ch, authority } = await requireChannel(db, channelId, userId, Permission.Connect);
  if (ch.kind !== "voice") throw new AppError("invalid", "This isn't a voice channel.");
  const [me] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
  const sources = publishSources(authority);
  const at = new AccessToken(apiKey, apiSecret, { identity: userId, name: me?.name, ttl: TOKEN_TTL_SECONDS });
  at.addGrant({
    room: ch.id,
    roomJoin: true,
    canSubscribe: true,
    canPublish: sources.length > 0,
    canPublishSources: sources,
    // No data channel: chat stays in text channels, where it is moderated.
    canPublishData: false,
  });
  return {
    url: url!,
    token: await at.toJwt(),
    canSpeak: sources.includes(TrackSource.MICROPHONE),
    canVideo: sources.includes(TrackSource.CAMERA),
  };
}

/** Unreachable product preparation. Signing happens only after the locked grant commits.
 * A later revoke can race signing/delivery; generation-room/key lifecycle is required at activation. */
export async function createBoundVoiceToken(rawAuth: unknown, binding: unknown) {
  if (!voiceEnabled) throw new AppError("not_found", "Voice isn't set up on this instance.");
  const grant = await grantBoundVoiceMedia(rawAuth, binding);
  const expiresAt = Date.parse(grant.expiresAt);
  const ttl = Math.min(TOKEN_TTL_SECONDS, Math.floor(expiresAt / 1000) - Math.ceil(Date.now() / 1000));
  if (ttl < 1) throw new AppError("forbidden", "This voice enrollment has ended.");
  const sourceTypes: Record<VoiceMediaSource, TrackSource> = { microphone: TrackSource.MICROPHONE, camera: TrackSource.CAMERA, screen_share: TrackSource.SCREEN_SHARE, screen_share_audio: TrackSource.SCREEN_SHARE_AUDIO };
  const token = new AccessToken(apiKey, apiSecret, { identity: grant.participantIdentity, ttl });
  token.addGrant({ room: grant.roomName, roomJoin: true, canSubscribe: true, canPublish: grant.sources.length > 0, canPublishSources: grant.sources.map(source => sourceTypes[source]), canPublishData: false, canUpdateOwnMetadata: false });
  const signingDeadline = Math.min(expiresAt, (Math.floor(Date.now() / 1000) + ttl) * 1000);
  const jwt = await token.toJwt();
  // The SDK sets exp relative to its own signing-time clock. A synchronous pause before that
  // point can outlive the conservative TTL calculation, so verify the actual signed claims.
  const claims = await new TokenVerifier(apiKey!, apiSecret!).verify(jwt, 0).catch(() => {
    throw new AppError("forbidden", "This voice enrollment has ended.");
  });
  if (typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp > Math.floor(expiresAt / 1000) || claims.exp * 1000 <= Date.now() || Date.now() >= signingDeadline) throw new AppError("forbidden", "This voice enrollment has ended.");
  return { url: url!, token: jwt, ...grant };
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
 * people who lost Speak or Video can no longer publish those tracks. Best effort, so moderation never fails because LiveKit is down.
 */
export async function reconcileVoice(communityId: string): Promise<void> {
  if (!voiceEnabled) return;
  const voiceChannels = await db
    .select({ id: channel.id })
    .from(channel)
    .where(and(eq(channel.communityId, communityId), eq(channel.kind, "voice")));
  const client = rooms();
  for (const ch of voiceChannels) {
    const participants = await client.listParticipants(ch.id).catch((error: unknown) => {
      console.error("[voice] could not list participants", ch.id, error);
      return [];
    });
    for (const p of participants) {
      const access = await loadChannelAuthority(db, ch.id, p.identity).catch(() => null);
      if (!access || !has(access.authority, Permission.Connect)) {
        await client.removeParticipant(ch.id, p.identity).catch(() => {});
      } else {
        // Narrow what they may publish when Speak or Video was taken away; LiveKit unpublishes the rest.
        const allowed = publishSources(access.authority);
        const current = p.permission?.canPublishSources ?? [];
        if (current.some((source) => !allowed.includes(source)) || (allowed.length === 0 && p.permission?.canPublish)) {
          await client
            .updateParticipant(ch.id, p.identity, {
              permission: { canSubscribe: true, canPublish: allowed.length > 0, canPublishSources: allowed, canPublishData: false },
            })
            .catch(() => {});
        }
      }
    }
  }
}

/** Closes a deleted voice channel's room. */
export async function closeVoiceRoom(channelId: string): Promise<void> {
  if (voiceEnabled) await rooms().deleteRoom(channelId).catch(() => {});
}

/**
 * Fire-and-forget wrapper for mutations: log, never throw. Runs now and once more after the token
 * lifetime, which catches someone who fetched a token just before losing access and connected after.
 */
export function afterAccessChange(communityId: string): void {
  if (!voiceEnabled) return;
  const run = () => void reconcileVoice(communityId).catch((error: unknown) => console.error("[voice] reconcile failed", error));
  run();
  setTimeout(run, RECHECK_AFTER_MS).unref?.();
}
