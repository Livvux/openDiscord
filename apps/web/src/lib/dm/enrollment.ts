import { z } from "zod";

// Canonical DM metadata: extraction preserves the existing parser and DM behavior.
export const dmMetadataSchema = z.object({ id: z.uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/), storeKey: z.string().min(32) });
export type ExistingDmEnrollment = { id: string; secret: string };

/** Read the existing anchor only. Missing/invalid/unavailable storage requires explicit DM setup. */
export function readExistingDmEnrollment(userId: string): ExistingDmEnrollment | null {
  try {
    if (typeof window === "undefined") return null;
    const saved = window.localStorage.getItem(`opendiscord.dm.device:${userId}`);
    if (!saved) return null;
    const metadata = dmMetadataSchema.safeParse(JSON.parse(saved));
    return metadata.success ? { id: metadata.data.id, secret: metadata.data.secret } : null;
  } catch {
    return null;
  }
}
