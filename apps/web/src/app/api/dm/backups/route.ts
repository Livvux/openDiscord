import { DM_MAX_BACKUP_BYTES } from "@/lib/dm/contracts";
import { deleteDmBackup, getDmBackup, listDmBackups, saveDmBackup } from "@/server/direct-messages";
import { assertDmOrigin, requireDmDevice } from "@/server/dm-http";
import { errorResponse, PRIVATE_NO_STORE, readJsonBody } from "@/server/http";
import { consume } from "@/server/limits";
import { requireUser } from "@/server/session";
import { parse, uuid } from "@/server/validation";
import { z } from "zod";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request.headers);
    await consume(`dm-backup-read:${user.id}`, 30, 60_000);
    const id = new URL(request.url).searchParams.get("id");
    return Response.json(id ? await getDmBackup(user.id, id) : { backups: await listDmBackups(user.id) }, { headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertDmOrigin(request);
    const auth = await requireDmDevice(request);
    // Before the (up to several MB) body is read and parsed.
    await consume(`dm-backup:${auth.userId}`, 10, 3_600_000);
    await saveDmBackup(auth, await readJsonBody(request, Math.ceil(DM_MAX_BACKUP_BYTES * 4 / 3) + 1024));
    return Response.json({}, { headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request) {
  try {
    assertDmOrigin(request);
    const user = await requireUser(request.headers);
    const { id } = parse(z.object({ id: uuid }).strict(), await readJsonBody(request, 1024));
    await deleteDmBackup(user.id, id);
    return Response.json({}, { headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
