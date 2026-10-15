import { z } from "zod";
import { deviceIdSchema, deviceSecretSchema, type DmDeviceAuth } from "@/lib/dm/contracts";
import { forbidden } from "./errors";
import { requireUser } from "./session";
import { parse } from "./validation";

export function assertDmOrigin(request: Request): void {
  const expected = new URL(process.env.BETTER_AUTH_URL ?? request.url).origin;
  if (request.headers.get("origin") !== expected || request.headers.get("sec-fetch-site") === "cross-site") throw forbidden("Use this site's private messaging interface.");
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw forbidden("Send JSON.");
}
export async function requireDmDevice(request: Request): Promise<DmDeviceAuth> {
  const user = await requireUser(request.headers);
  return { userId: user.id, deviceId: parse(deviceIdSchema, request.headers.get("x-dm-device")), secret: parse(deviceSecretSchema, request.headers.get("x-dm-device-secret")) };
}
export const dmActionSchema = z.object({ action: z.string().max(40) }).passthrough();
