import { handleCryptoRequest } from "@/server/direct-messages";
import { assertDmOrigin, requireDmDevice } from "@/server/dm-http";
import { errorResponse, PRIVATE_NO_STORE, readJsonBody } from "@/server/http";

export async function POST(request: Request) {
  try {
    assertDmOrigin(request);
    const auth = await requireDmDevice(request);
    return Response.json(await handleCryptoRequest(auth, await readJsonBody(request, 512_000)), { headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
