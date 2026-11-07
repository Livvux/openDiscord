// Profile text beyond the display name (which Better Auth owns). Shown only where the account is
// already visible: friends lists today.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { userProfile } from "@/db/schema";
import { parse } from "./validation";

export const BIO_MAX = 190;
export const CUSTOM_STATUS_MAX = 80;
// Single-line status; the bio keeps newlines but no other control characters.
// Bidi overrides/isolates are refused too: they can make a status read as someone else's text.
const BIDI = /[\u202A-\u202E\u2066-\u2069]/;
const noControl = (allowNewline: boolean) => (v: string) => !(allowNewline ? /[\u0000-\u0009\u000B-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/).test(v) && !BIDI.test(v);
const profileInput = z
  .object({
    bio: z.string().trim().max(BIO_MAX, `Use at most ${BIO_MAX} characters.`).refine(noControl(true), "Remove control characters."),
    customStatus: z.string().trim().max(CUSTOM_STATUS_MAX, `Use at most ${CUSTOM_STATUS_MAX} characters.`).refine(noControl(false), "Use a single line."),
  })
  .strict();

export interface Profile {
  bio: string;
  customStatus: string;
}

export async function getProfile(userId: string): Promise<Profile> {
  const [row] = await db.select({ bio: userProfile.bio, customStatus: userProfile.customStatus }).from(userProfile).where(eq(userProfile.userId, userId));
  return row ?? { bio: "", customStatus: "" };
}

export async function updateProfile(userId: string, input: unknown): Promise<void> {
  const set = parse(profileInput, input);
  await db.insert(userProfile).values({ userId, ...set }).onConflictDoUpdate({ target: userProfile.userId, set });
}

export async function setCustomStatus(userId: string, input: unknown): Promise<void> {
  const { customStatus } = parse(profileInput.pick({ customStatus: true }), { customStatus: input });
  await db.insert(userProfile).values({ userId, customStatus }).onConflictDoUpdate({ target: userProfile.userId, set: { customStatus } });
}
