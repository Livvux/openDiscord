// Voice channels on a self-hosted LiveKit SFU (docs/DECISIONS.md D8). LiveKit never reads our
// database: we hand out short-lived room tokens after the usual permission checks, and remove people
// from rooms when they lose access (kick, ban, role or channel changes).
import { and, eq } from "drizzle-orm";
import { AccessToken, RoomServiceClient, TokenVerifier, TrackSource } from "livekit-server-sdk";
import { db } from "@/db";
import { channel } from "@/db/schema";
import { loadChannelAuthority } from "./access";
import { AppError } from "./errors";
import { has, Permission } from "./permissions";
import { grantBoundVoiceMedia } from "./voice-control";
import { assertOwnedVoiceRoomActive, consumeVoiceRooms, createOwnedVoiceRoom, createVoiceRoomBudget, retireOwnedVoiceRoom, voiceRoomService } from "./voice-sfu";
import type { VoiceMediaSource } from "@/lib/voice/contracts";

const url = process.env.LIVEKIT_URL;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;

/** Voice is optional: without LiveKit settings, voice channels can't be created or joined. */
export const voiceEnabled = Boolean(url && apiKey && apiSecret);
/**
 * Tokens can't be revoked, so they only need to live long enough to connect: once connected, LiveKit
 * refreshes the session itself. This app TTL does not bound refreshed reconnect tokens;
 * generation ownership remains durable and retired rooms require recurring exact cleanup.
 */
const TOKEN_TTL_SECONDS = 60;
const LEGACY_RECHECK_AFTER_MS = (TOKEN_TTL_SECONDS + 5) * 1000;

/** The server API can live on a private address (compose: http://livekit:7880); defaults to the public URL. */
const apiUrl = process.env.LIVEKIT_API_URL || url?.replace(/^ws/, "http");

function rooms(): RoomServiceClient {
  return voiceRoomService() ?? new RoomServiceClient(apiUrl!, apiKey!, apiSecret!, { requestTimeout: 0.5, failover: false });
}

/** What a member may publish, from their channel permissions. */
function publishSources(authority: Parameters<typeof has>[0]): TrackSource[] {
  return [
    ...(has(authority, Permission.Speak) ? [TrackSource.MICROPHONE] : []),
    ...(has(authority, Permission.Video) ? [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : []),
  ];
}

/** Bound product media issuer. Signing happens only after the locked grant commits.
 * A later revoke can race signing/delivery; generation-room/key lifecycle is required at activation. */
export async function createBoundVoiceToken(rawAuth: unknown, binding: unknown) {
  if (!voiceEnabled) throw new AppError("not_found", "Voice isn't set up on this instance.");
  const budget = createVoiceRoomBudget();
  const reserved = await grantBoundVoiceMedia(rawAuth, binding, { budget, deferUntilRevalidation: true });
  await createOwnedVoiceRoom(reserved.roomName, budget);
  let grant: Awaited<ReturnType<typeof grantBoundVoiceMedia>>;
  try { grant = await grantBoundVoiceMedia(rawAuth, binding, { budget }); }
  catch (error) {
    await retireOwnedVoiceRoom(reserved.roomName);
    await consumeVoiceRooms({ budget });
    throw error;
  }
  if (grant.roomName !== reserved.roomName) throw new AppError("conflict", "Voice membership changed.");
  await assertOwnedVoiceRoomActive(grant.roomName);
  if (performance.now() > budget.deadline) throw new AppError("conflict", "Voice is temporarily busy. Try again.");
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
  if (typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp > Math.floor(expiresAt / 1000) || claims.exp * 1000 <= Date.now() || Date.now() >= signingDeadline || performance.now() > budget.deadline) throw new AppError("forbidden", "This voice enrollment has ended.");
  return { url: url!, token: jwt, ...grant };
}

/**
 * Re-checks everyone in the community's voice rooms: people who can no longer connect are removed,
 * people who lost Speak or Video can no longer publish those tracks. Best effort, so moderation never fails because LiveKit is down.
 */
export async function reconcileVoice(communityId: string): Promise<void> {
  await consumeVoiceRooms();
  await reconcileLegacyVoice(communityId);
}

async function reconcileLegacyVoice(communityId: string): Promise<void> {
  if (!voiceEnabled) return;
  const voiceChannels = await db
    .select({ id: channel.id })
    .from(channel)
    .where(and(eq(channel.communityId, communityId), eq(channel.kind, "voice")));
  const client = rooms();
  // Preserve existing legacy coverage until the coherent product activation removes its issuer.
  // Sequential SDK requests retain a per-request bound without dropping later channels/participants.
  for (const ch of voiceChannels) {
    const participants = await client.listParticipants(ch.id).catch((error: unknown) => {
      void error;
      console.warn("[voice] legacy room unavailable");
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

/** Awaited legacy exact-channel reconciliation; retired generation cleanup remains durable. */
export async function afterAccessChange(communityId: string): Promise<void> {
  await reconcileVoice(communityId).catch(() => console.warn("[voice] reconciliation deferred"));
  if (voiceEnabled) {
    // Compatibility only: refreshed SFU tokens mean this is not a finite revocation guarantee.
    const recheck = () => reconcileLegacyVoice(communityId).catch(() => console.warn("[voice] legacy reconciliation deferred"));
    setTimeout(recheck, LEGACY_RECHECK_AFTER_MS).unref?.();
  }
}
