import { MAX_ARCHIVE_COMPRESSED_BYTES } from "@/lib/limits";
import { importCommunityArchive } from "@/server/community-archive";
import { forbidden, invalid } from "@/server/errors";
import { importCommunity } from "@/server/community-export";
import { errorResponse, PRIVATE_NO_STORE, readJsonBody } from "@/server/http";
import { consume } from "@/server/limits";
import { requireUser } from "@/server/session";

const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

/** Creates a new community from an export file (the body). */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request.headers);
    if (request.headers.get("origin") !== new URL(process.env.BETTER_AUTH_URL ?? request.url).origin) throw forbidden("Import from this instance's application.");
    const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (type !== "application/json" && type !== "application/gzip") throw invalid("Send a JSON export or gzip community archive.");
    await consume(`import:${user.id}`, 3, 60 * 60_000);
    if (type === "application/gzip") {
      if (!request.body || Number(request.headers.get("content-length") ?? 0) > MAX_ARCHIVE_COMPRESSED_BYTES) throw invalid("The archive is missing or too large.");
      const communityId = await importCommunityArchive(user, request.body, request.signal);
      return Response.json({ communityId }, { status: 201, headers: PRIVATE_NO_STORE });
    }
    const communityId = await importCommunity(user.id, await readJsonBody(request, MAX_IMPORT_BYTES));
    return Response.json({ communityId }, { status: 201, headers: PRIVATE_NO_STORE });
  } catch (error) {
    await request.body?.cancel().catch(() => {});
    return errorResponse(error);
  }
}
