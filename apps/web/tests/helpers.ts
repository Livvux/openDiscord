import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { REGISTRATION_HEADER, registrationAttestation } from "@/lib/registration-policy";
import { getMinimumAge } from "@/server/operator-policy";
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

export const REGISTRATION_HEADERS = { [REGISTRATION_HEADER]: registrationAttestation(getMinimumAge()) };
