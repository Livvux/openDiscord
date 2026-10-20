import { exportUserData } from "@/server/account";
import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { consume } from "@/server/limits";
import { requireUser } from "@/server/session";

/** GDPR Art. 15/20: download everything stored about the signed-in person as JSON. */
export async function GET(request: Request) {
  try {
    const user = await requireUser(request.headers);
    // Each export reads every message and file reference of the account.
    await consume(`export-me:${user.id}`, 3, 3_600_000);
    const data = await exportUserData(user.id);
    const date = data.exportedAt.slice(0, 10);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        ...PRIVATE_NO_STORE,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="opendiscord-export-${date}.json"`,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
