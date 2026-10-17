import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

const handlers = toNextJsHandler(auth);
export const POST = handlers.POST;

export async function GET(request: Request) {
  const response = await handlers.GET(request);
  // Email verification can succeed while automatic sign-in is blocked by alpha approval.
  if (new URL(request.url).pathname === "/api/auth/verify-email" && response.status === 403) {
    const error: unknown = await response.clone().json();
    if (error && typeof error === "object" && "code" in error && error.code === "ACCOUNT_PENDING") {
      return new Response(null, { status: 303, headers: { Location: "/sign-in?error=pending", "Cache-Control": "no-store" } });
    }
  }
  return response;
}
