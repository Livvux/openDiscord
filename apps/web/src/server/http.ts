import { unstable_rethrow } from "next/navigation";
import { AppError, HTTP_STATUS } from "./errors";

/** JSON error response for route handlers; unexpected errors are logged, not leaked. */
export function errorResponse(error: unknown): Response {
  // Let Next.js control-flow signals (prerender bail-out, redirects) through.
  unstable_rethrow(error);
  if (error instanceof AppError) {
    return Response.json({ error: error.message }, { status: HTTP_STATUS[error.code] });
  }
  console.error("[api] unexpected error", error);
  return Response.json({ error: "Something went wrong." }, { status: 500 });
}

export const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };
