import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { requireUser } from "@/server/session";

/** Keys for these browser-based APIs are public by design; only authenticated users need them. */
export async function GET(request: Request) {
  try {
    await requireUser(request.headers);
    return Response.json({
      klipy: process.env.KLIPY_APP_KEY?.trim() || null,
      giphy: process.env.GIPHY_API_KEY?.trim() || null,
    }, { headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
