import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, community } from "@/db/schema";
import { lockCommunity, requireMember } from "./access";
import { forbidden } from "./errors";
import { ONLINE_WINDOW_MS } from "./presence";
import { activeUser } from "./public-channels";
import { parse, uuid } from "./validation";

export const DISCOVER_LIMIT = 60;
export const DESCRIPTION_MAX = 300;

export interface DiscoverableCommunity {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  onlineCount: number;
}

export interface DiscoverablePreview extends DiscoverableCommunity {
  rules: string;
  rulesVersion: number;
  rulesRequired: boolean;
}

const listed = () => and(eq(community.discoverable, true), isNull(community.suspendedAt), activeUser(sql`${community.ownerId}`));
const columns = {
  id: community.id,
  name: community.name,
  description: community.description,
  memberCount: sql<number>`(select count(*)::int from member m where m.community_id = ${community.id})`,
  // Aggregate only, and only people who opted into showing their status.
  onlineCount: sql<number>`(select count(*)::int from member m join user_presence p on p.user_id = m.user_id
    where m.community_id = ${community.id} and p.visible and p.last_seen_at > now() - make_interval(secs => ${ONLINE_WINDOW_MS / 1000}))`,
};

// shortcut: biggest communities first, capped at DISCOVER_LIMIT; add pagination or categories once the directory outgrows one page.
export async function listDiscoverable(rawQuery?: unknown): Promise<DiscoverableCommunity[]> {
  const q = z.string().trim().max(100).catch("").parse(rawQuery ?? "");
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const match = q ? sql`(${community.name} ilike ${pattern} or ${community.description} ilike ${pattern})` : undefined;
  return db.select(columns).from(community).where(and(listed(), match))
    .orderBy(desc(columns.memberCount), community.id).limit(DISCOVER_LIMIT)
    .then((rows) => rows.map((r) => ({ ...r, memberCount: Number(r.memberCount), onlineCount: Number(r.onlineCount) })));
}

export async function getDiscoverable(rawId: unknown): Promise<DiscoverablePreview | null> {
  const id = uuid.safeParse(rawId);
  if (!id.success) return null;
  const [row] = await db.select({ ...columns, rules: community.rules, rulesVersion: community.rulesVersion, rulesRequired: community.rulesRequired })
    .from(community).where(and(eq(community.id, id.data), listed()));
  return row ? { ...row, memberCount: Number(row.memberCount), onlineCount: Number(row.onlineCount) } : null;
}

const listingInput = z.object({ discoverable: z.boolean(), description: z.string().trim().max(DESCRIPTION_MAX, `Use at most ${DESCRIPTION_MAX} characters.`) }).strict();

export async function getListing(userId: string, rawCommunityId: unknown) {
  const communityId = parse(uuid, rawCommunityId);
  const { community: c } = await requireMember(db, communityId, userId);
  return { discoverable: c.discoverable, description: c.description };
}

/** Owner only: listing makes the community joinable by anyone, without an invite. */
export async function updateListing(userId: string, rawCommunityId: unknown, rawInput: unknown): Promise<void> {
  const communityId = parse(uuid, rawCommunityId);
  const input = parse(listingInput, rawInput);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    const { authority, community: c } = await requireMember(tx, communityId, userId);
    if (!authority.isOwner) throw forbidden("Only the owner can list this community in Discover.");
    await tx.update(community).set(input).where(eq(community.id, communityId));
    if (input.discoverable !== c.discoverable) {
      await tx.insert(auditLog).values({ communityId, actorId: userId, action: input.discoverable ? "discover.list" : "discover.unlist" });
    }
  });
}
