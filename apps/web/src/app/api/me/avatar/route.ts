import { removeAvatar, setAvatar } from "@/server/avatars";
import { assertSameOrigin, errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { readLimited } from "@/server/media";
import { requireUser } from "@/server/session";

/** Raw raster body: the cropped square from the profile settings. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request.headers);
    const avatar = await setAvatar(user.id, Number(request.headers.get("content-length")), (limit) => readLimited(request.body, limit), request.signal);
    return Response.json({ avatar }, { status: 201, headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request.headers);
    await removeAvatar(user.id);
    return new Response(null, { status: 204, headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
