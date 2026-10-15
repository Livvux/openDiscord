import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { community, user } from "@/db/schema";

/** Creates users directly in the database and removes them (and their communities) afterwards. */
export function testUsers() {
  const ids: string[] = [];
  return {
    async create(name: string): Promise<string> {
      const id = randomUUID();
      await db.insert(user).values({ id, name, email: `${id}@example.test` });
      ids.push(id);
      return id;
    },
    async cleanup() {
      if (ids.length === 0) return;
      await db.delete(community).where(inArray(community.ownerId, ids));
      await db.delete(user).where(inArray(user.id, ids));
    },
  };
}
