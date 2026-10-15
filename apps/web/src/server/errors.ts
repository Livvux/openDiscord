import { unstable_rethrow } from "next/navigation";

export type AppErrorCode = "unauthorized" | "forbidden" | "not_found" | "invalid" | "rate_limited" | "conflict";

/** Expected failure with a message that is safe to show to the user. */
export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what = "Not found") => new AppError("not_found", what);
export const forbidden = (why = "You don't have permission to do that.") => new AppError("forbidden", why);
export const invalid = (why: string) => new AppError("invalid", why);

export const HTTP_STATUS: Record<AppErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  rate_limited: 429,
  conflict: 409,
};

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

/** Runs a mutation for a server action; expected errors become messages, the rest are logged. */
export async function toResult<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error: unknown) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    // Rethrow Next.js control flow (redirect/notFound) untouched.
    unstable_rethrow(error);
    console.error("[action] unexpected error", error);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
