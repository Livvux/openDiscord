import { unstable_rethrow } from "next/navigation";
import { AppError, forbidden, HTTP_STATUS } from "./errors";

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

/**
 * Parses a JSON body of at most `maxBytes`, refusing oversized bodies by their announced length
 * before reading, and cutting off bodies that are longer than announced.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const announced = Number(request.headers.get("content-length") ?? "0");
  if (announced > maxBytes) throw new AppError("invalid", "The request body is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("invalid", "Send a JSON body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    size += r.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AppError("invalid", "The request body is too large.");
    }
    chunks.push(r.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("invalid", "Send a JSON body.");
  }
}

/** Cookie-authenticated raw upload/delete routes require the application's exact origin. */
export function assertSameOrigin(request: Request): void {
  const expected = new URL(process.env.BETTER_AUTH_URL ?? request.url).origin;
  if (request.headers.get("origin") !== expected || request.headers.get("sec-fetch-site") === "cross-site") throw forbidden("Use this instance's application.");
}
