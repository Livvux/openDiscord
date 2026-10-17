import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { user, session } from "@/db/schema";
import { auth } from "@/lib/auth";
import { assertVoiceOrigin, requireVoiceJoin, requireVoiceMember, VOICE_RESPONSE_HEADERS } from "@/server/voice-http";
import { REGISTRATION_HEADERS } from "./helpers";

const ids: string[] = [];
const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
const device = randomUUID(), secret = "a".repeat(64);
afterAll(async () => { if (ids.length) await db.delete(user).where(inArray(user.id, ids)); });
const request = (headers: Record<string, string> = {}) => new Request(`${origin}/not-a-route`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers } });
describe("unreachable Voice HTTP trust boundary", () => {
  it("requires configured exact origin and JSON media type", () => {
    expect(() => assertVoiceOrigin(request())).not.toThrow();
    expect(VOICE_RESPONSE_HEADERS).toEqual({ "Cache-Control": "private, no-store" });
    const rejected: Record<string, string>[] = [{ origin: "https://foreign.test" }, { origin: "" }, { "sec-fetch-site": "cross-site" }, { "content-type": "application/jsonp" }, { "content-type": "text/plain" }];
    for (const headers of rejected) expect(() => assertVoiceOrigin(request(headers))).toThrow();
  });
  it("rejects header account/session spoofing without an authentic cookie", async () => {
    await expect(requireVoiceJoin(request({ "x-user-id": randomUUID(), "x-session-id": randomUUID(), "x-dm-device": device, "x-dm-device-secret": secret }))).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("derives account/session from real signed cookie and maps canonical possession headers only", async () => {
    const signup = await auth.api.signUpEmail({ headers: REGISTRATION_HEADERS, body: { email: `voice-http-${randomUUID()}@example.test`, password: "correct horse battery", name: "Voice HTTP" }, returnHeaders: true });
    ids.push(signup.response.user.id);
    const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).not.toBe("");
    const headers = { cookie, "x-user-id": "spoofed", "x-session-id": "spoofed", "x-dm-device": device, "x-dm-device-secret": secret, "x-voice-member": device, "x-voice-secret": secret };
    const joined = await requireVoiceJoin(request(headers));
    expect(joined).toMatchObject({ userId: signup.response.user.id, anchorDeviceId: device, anchorSecret: secret });
    expect(joined.sessionId).not.toBe("spoofed");
    const member = await requireVoiceMember(request(headers));
    expect(member).toEqual({ userId: joined.userId, sessionId: joined.sessionId, memberId: device, secret });
    await expect(requireVoiceMember(request({ ...headers, "x-voice-secret": "bad" }))).rejects.toMatchObject({ code: "invalid" });
    await expect(requireVoiceJoin(request({ ...headers, "x-dm-device": "bad" }))).rejects.toMatchObject({ code: "invalid" });
    await db.delete(session).where(eq(session.id, joined.sessionId));
    await expect(requireVoiceMember(request(headers))).rejects.toMatchObject({ code: "unauthorized" });
  });
});
