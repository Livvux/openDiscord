import { appendDirectMessage, createDirectConversation, listDirectConversations, listDirectMessages, listDmDevices, registerDmDevice, reportDirectMessage, respondToDirectRequest, revokeDmDevice } from "@/server/direct-messages";
import { assertDmOrigin, dmActionSchema, requireDmDevice } from "@/server/dm-http";
import { invalid } from "@/server/errors";
import { errorResponse, PRIVATE_NO_STORE, readJsonBody } from "@/server/http";
import { consume } from "@/server/limits";
import { requireUser } from "@/server/session";
import { parse, uuid } from "@/server/validation";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request.headers);
    await consume(`dm-read:${user.id}`, 120, 60_000);
    const params = new URL(request.url).searchParams;
    const conversation = params.get("conversation");
    if (conversation) return Response.json(await listDirectMessages(user.id, conversation, params.get("before") ?? undefined), { headers: PRIVATE_NO_STORE });
    const target = params.get("devices");
    if (target) return Response.json({ devices: await listDmDevices(user.id, target) }, { headers: PRIVATE_NO_STORE });
    return Response.json({ conversations: await listDirectConversations(user.id), devices: await listDmDevices(user.id) }, { headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertDmOrigin(request);
    const user = await requireUser(request.headers);
    await consume(`dm-mutation:${user.id}`, 60, 60_000);
    const body = parse(dmActionSchema, await readJsonBody(request, 32_000));
    let result: unknown = {};
    switch (body.action) {
      case "register": await registerDmDevice(user.id, user.sessionId, body.input); break;
      case "request": result = { id: await createDirectConversation(user.id, body.target) }; break;
      case "respond": await respondToDirectRequest(user.id, parse(uuid, body.id), body.status); break;
      case "send": result = await appendDirectMessage(await requireDmDevice(request), parse(uuid, body.id), body.input); break;
      case "report": await reportDirectMessage(user.id, { id: body.id, reason: body.reason, excerpt: body.excerpt }); break;
      case "revoke": await revokeDmDevice(user.id, parse(uuid, body.id)); break;
      default: throw invalid("Unknown private messaging operation.");
    }
    return Response.json(result, { headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
