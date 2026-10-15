import { exportUserData } from "@/server/account";
import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { requireUser } from "@/server/session";

/** GDPR Art. 15/20: download everything stored about the signed-in person as JSON. */
export async function GET(request: Request) {
  try {
    const user = await requireUser(request.headers);
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
