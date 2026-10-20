import { handleCryptoRequest } from "@/server/direct-messages";
import { assertDmOrigin, requireDmDevice } from "@/server/dm-http";
import { errorResponse, PRIVATE_NO_STORE, readJsonBody } from "@/server/http";
import { consume } from "@/server/limits";

export async function POST(request: Request) {
  try {
    assertDmOrigin(request);
    const auth = await requireDmDevice(request);
    // Before the body is read and parsed.
    await consume(`dm-crypto:${auth.userId}`, 240, 60_000);
    return Response.json(await handleCryptoRequest(auth, await readJsonBody(request, 512_000)), { headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
