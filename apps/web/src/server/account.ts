// GDPR: data access/portability (export) and erasure (account deletion via Better Auth).
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, channel, community, member, message, passkey, session, user } from "@/db/schema";
import { notFound } from "./errors";

export const EXPORT_FORMAT_VERSION = 1;

export interface UserExport {
  format: "opendiscord.user-export";
  version: number;
  exportedAt: string;
  profile: { id: string; name: string; email: string; emailVerified: boolean; createdAt: string };
  sessions: { createdAt: string; expiresAt: string; userAgent: string | null }[];
  security: { twoFactorEnabled: boolean; passkeys: { name: string | null; deviceType: string; createdAt: string | null }[] };
  ownedCommunities: { id: string; name: string; createdAt: string }[];
  memberships: { communityId: string; communityName: string; joinedAt: string }[];
  messages: { id: string; communityId: string; channelName: string; content: string; createdAt: string; editedAt: string | null }[];
}

/** Everything stored about the person, as portable JSON. Excludes secrets (password hash, tokens). */
export async function exportUserData(userId: string): Promise<UserExport> {
  const [profile] = await db.select().from(user).where(eq(user.id, userId));
  if (!profile) throw notFound("Account not found.");
  const [sessions, passkeys, owned, memberships, messages] = await Promise.all([
    db.select().from(session).where(eq(session.userId, userId)).orderBy(asc(session.createdAt)),
    db.select().from(passkey).where(eq(passkey.userId, userId)),
    db.select().from(community).where(eq(community.ownerId, userId)),
    db
      .select({ communityId: member.communityId, communityName: community.name, joinedAt: member.joinedAt })
      .from(member)
      .innerJoin(community, eq(community.id, member.communityId))
      .where(eq(member.userId, userId)),
    db
      .select({
        id: message.id,
        communityId: channel.communityId,
        channelName: channel.name,
        content: message.content,
        createdAt: message.createdAt,
        editedAt: message.editedAt,
      })
      .from(message)
      .innerJoin(channel, eq(channel.id, message.channelId))
      .where(eq(message.authorId, userId))
      .orderBy(asc(message.id)),
  ]);

  return {
    format: "opendiscord.user-export",
    version: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    profile: {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      emailVerified: profile.emailVerified,
      createdAt: profile.createdAt.toISOString(),
    },
    sessions: sessions.map((s) => ({
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      userAgent: s.userAgent,
    })),
    // Public keys and TOTP secrets are credentials, not personal content: only their existence is exported.
    security: {
      twoFactorEnabled: profile.twoFactorEnabled === true,
      passkeys: passkeys.map((p) => ({ name: p.name, deviceType: p.deviceType, createdAt: p.createdAt?.toISOString() ?? null })),
    },
    ownedCommunities: owned.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt.toISOString() })),
    memberships: memberships.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() })),
    messages: messages.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
      editedAt: m.editedAt?.toISOString() ?? null,
    })),
  };
}

export async function ownedCommunityNames(userId: string): Promise<string[]> {
  const rows = await db.select({ name: community.name }).from(community).where(eq(community.ownerId, userId));
  return rows.map((r) => r.name);
}

export async function twoFactorEnabled(userId: string): Promise<boolean> {
  const [row] = await db.select({ enabled: user.twoFactorEnabled }).from(user).where(eq(user.id, userId));
  return row?.enabled === true;
}

/** Erasure: audit entries about a deleted person keep the action but lose the link to them. */
export async function unlinkFromAuditLog(userId: string): Promise<void> {
  await db.update(auditLog).set({ targetId: null }).where(eq(auditLog.targetId, userId));
}
