import { importCommunity } from "@/server/community-export";
import { errorResponse, PRIVATE_NO_STORE, readJsonBody } from "@/server/http";
import { consume } from "@/server/limits";
import { requireUser } from "@/server/session";

const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/** Creates a new community from an export file (the body). */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request.headers);
    consume(`import:${user.id}`, 3, 60 * 60_000);
    const communityId = await importCommunity(user.id, await readJsonBody(request, MAX_IMPORT_BYTES));
    return Response.json({ communityId }, { status: 201, headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
