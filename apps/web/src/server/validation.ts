import { z } from "zod";
import { MESSAGE_MAX_LENGTH } from "@/lib/limits";
import { invalid } from "./errors";

export { MESSAGE_MAX_LENGTH };

export const communityName = z.string().trim().min(1, "Give your community a name.").max(64, "Use at most 64 characters.");

/** Channel names are lowercase slugs: "General Chat" becomes "general-chat". */
export const channelName = z
  .string()
  .transform((s) => s.trim().toLowerCase().replace(/\s+/g, "-"))
  .pipe(
    z
      .string()
      .min(1, "Give the channel a name.")
      .max(32, "Use at most 32 characters.")
      .regex(/^[\p{L}\p{N}_-]+$/u, "Use letters, numbers, dashes and underscores."),
  );

export const channelTopic = z.string().trim().max(256, "Use at most 256 characters.");

export const messageContent = z
  .string()
  .trim()
  .min(1, "Message is empty.")
  .max(MESSAGE_MAX_LENGTH, `Messages can be at most ${MESSAGE_MAX_LENGTH} characters.`);

export const roleName = z.string().trim().min(1, "Give the role a name.").max(32, "Use at most 32 characters.");

export const reason = z.string().trim().max(512, "Use at most 512 characters.").optional();

export const uuid = z.uuid("Invalid id.");

export const inviteOptions = z.object({
  expiresInHours: z.union([z.literal(1), z.literal(24), z.literal(168), z.null()]),
  maxUses: z.union([z.literal(1), z.literal(5), z.literal(25), z.literal(100), z.null()]),
});

export const inviteCode = z.string().regex(/^[A-Za-z0-9_-]{8,32}$/, "Invalid invite.");

/** Parses input or throws an AppError with the first validation message. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid(result.error.issues[0]?.message ?? "Invalid input.");
  return result.data;
}
