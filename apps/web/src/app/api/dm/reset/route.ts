import { z } from "zod";
import { auth } from "@/lib/auth";
import { assertDmOrigin } from "@/server/dm-http";
import { dmResetState, resetDmIdentity } from "@/server/dm-reset";
import { forbidden } from "@/server/errors";
import { errorResponse, PRIVATE_NO_STORE, readJsonBody } from "@/server/http";
import { consume } from "@/server/limits";
import { requireUser } from "@/server/session";
import { parse } from "@/server/validation";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request.headers);
    await consume(`dm-reset-read:${user.id}`, 20, 60_000);
    return Response.json(await dmResetState(user.id, user.sessionId), { headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertDmOrigin(request);
    const user = await requireUser(request.headers);
    await consume(`dm-reset:${user.id}`, 3, 15 * 60_000);
    const body = parse(z.object({ identity: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().min(1).max(256), code: z.string().regex(/^\d{6}$/).optional(), confirmed: z.literal(true) }).strict(), await readJsonBody(request, 4096));
    const state = await dmResetState(user.id, user.sessionId);
    if (!state.freshSession) throw forbidden("Sign in again within five minutes before resetting encryption.");
    try {
      const password = await auth.api.verifyPassword({ headers: request.headers, body: { password: body.password } });
      if (!password.status) throw new Error("Authentication failed");
      if (state.twoFactorEnabled) {
        if (!body.code) throw new Error("Authenticator code required");
        await auth.api.verifyTOTP({ headers: request.headers, body: { code: body.code, trustDevice: false } });
      }
    } catch { throw forbidden("Password or authenticator verification failed."); }
    await resetDmIdentity(user.id, user.sessionId, { identity: body.identity, twoFactorEnabled: state.twoFactorEnabled });
    return Response.json({}, { headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
