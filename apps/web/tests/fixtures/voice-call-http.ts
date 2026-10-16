import { randomBytes, randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { vi } from "vitest";
import { db } from "@/db";
import { channel, community, user } from "@/db/schema";
import { auth } from "@/lib/auth";
import type { VoiceProductOwnerPort } from "@/lib/voice/crypto-owner";
import { CallSession } from "@/lib/voice/call-session";
import { POST } from "@/app/api/voice/control/route";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { registerDmDevice } from "@/server/direct-messages";
import { requireUser } from "@/server/session";
import { REGISTRATION_HEADERS } from "../helpers";

const ids: string[] = [], sessions: CallSession[] = [];
export type CallHttpTrace = { action: string; kind?: string; generation?: number; start: number; status?: number };
export type CallAccount = { accountId: string; sessionId: string; channelId: string; cookie: string; calls: CallHttpTrace[]; before?: (body: { action: string; input: { expectedGeneration?: number; request?: { kind: string } } }) => Promise<Response | void>; after?: (response: Response, trace: CallHttpTrace) => Promise<Response | void>; valid: boolean; call?: CallSession };
const anchors = new Map<string, string>();
const nativeFailures = new Map<string, string[]>();
/** Observe only public-port failure categories; never report raw errors or payloads. */
export function observeCallPort(accountId: string, port: VoiceProductOwnerPort): VoiceProductOwnerPort {
  return Object.freeze({ ...port, receiveAgreement: async () => {
    try { return await port.receiveAgreement(); }
    catch (error) {
      const labels = new Map([["Missing native voice request.", "missing-native-request"], ["Unknown native SAS flow.", "unknown-native-flow"], ["Missing current native voice device.", "missing-native-device"]]);
      const values = nativeFailures.get(accountId) ?? [];
      if (values.length < 4) values.push(error instanceof Error ? labels.get(error.message) ?? "other-native-error" : "other-native-error");
      nativeFailures.set(accountId, values); throw error;
    }
  } });
}
function safeCallSummary(call: CallSession) {
  const view = call.getSnapshot(), account = sessions.includes(call) ? accountsByCall.get(call) : undefined;
  const actions = new Set(["join", "heartbeat", "leave", "token", "crypto"]), kinds = new Set(["ack", "signing", "send", "retire", "sync", "upload", "query", "claim", "signatures"]);
  const trace: Record<string, number> = {};
  for (const value of account?.calls ?? []) {
    const status = [200, 400, 401, 403, 404, 409, 429, 500].includes(value.status ?? 0) ? value.status : "other-or-pending";
    const key = `${actions.has(value.action) ? value.action : "other"}:${kinds.has(value.kind ?? "") ? value.kind : "none"}:${status}`;
    trace[key] = (trace[key] ?? 0) + 1;
  }
  return { state: view.state, error: view.error, rosterCount: view.roster.length, sasCount: view.sas.length, readyCount: view.sas.filter(value => value.ready).length, doneCount: view.sas.filter(value => value.done).length, admittedCount: view.admittedMemberIds.length, nativeFailureCategories: account ? nativeFailures.get(account.accountId) ?? [] : [], httpCounts: trace };
}
const accountsByCall = new WeakMap<CallSession, CallAccount>();
export async function callHttpFixture(count: number) {
  const held = new Set<string>();
  vi.stubGlobal("navigator", { locks: { async request(name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) { if (held.has(name)) return callback(null); held.add(name); try { await callback({ name }); } finally { held.delete(name); } } } });
  const events = new EventTarget();
  const writes = vi.fn();
  vi.stubGlobal("window", { performance: globalThis.performance, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), localStorage: { getItem: (key: string) => anchors.get(key) ?? null, setItem: writes } });
  const accounts: CallAccount[] = [];
  for (let i = 0; i < count; i++) {
    const signup = await auth.api.signUpEmail({ headers: REGISTRATION_HEADERS, body: { email: `call-session-${randomUUID()}@example.test`, password: "correct horse battery", name: `Call ${i}` }, returnHeaders: true });
    const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0], account = await requireUser(new Headers({ cookie }));
    ids.push(account.id);
    const anchor = { id: randomUUID(), secret: randomBytes(32).toString("hex"), name: "Call read-only anchor" };
    await registerDmDevice(account.id, account.sessionId, anchor);
    anchors.set(`opendiscord.dm.device:${account.id}`, JSON.stringify({ id: anchor.id, secret: anchor.secret, storeKey: randomBytes(32).toString("base64") }));
    accounts.push({ accountId: account.id, sessionId: account.sessionId, cookie, channelId: "", calls: [], valid: true });
  }
  const group = await createCommunity(accounts[0].accountId, "Call session actual HTTP");
  const invite = await createInvite(accounts[0].accountId, group.communityId, { expiresInHours: 1, maxUses: null });
  for (const account of accounts.slice(1)) await acceptInvite(account.accountId, invite);
  const [room] = await db.insert(channel).values({ communityId: group.communityId, kind: "voice", name: "call-control" }).returning();
  for (const account of accounts) account.channelId = room.id;
  return { accounts, writes, held, events };
}
export async function startCall(account: CallAccount): Promise<CallSession> {
  const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
  const call = await CallSession.create({ accountId: account.accountId, sessionId: account.sessionId, channelId: account.channelId, consent: true, assertSessionCurrent() { if (!account.valid) throw new Error("Actual session replaced."); }, fetch: async (path, init) => {
    const body = JSON.parse(String(init?.body));
    const trace: CallHttpTrace = { action: body.action, kind: body.input.request?.kind, generation: body.input.expectedGeneration, start: performance.now() };
    account.calls.push(trace);
    const intercepted = await account.before?.(body);
    let response = intercepted ?? await POST(new Request(`${origin}${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin, cookie: account.cookie } }));
    response = await account.after?.(response, trace) ?? response;
    trace.status = response.status; return response;
  } });
  account.call = call; accountsByCall.set(call, account); sessions.push(call); return call;
}
export async function until(predicate: () => boolean, timeout = 12_000): Promise<void> {
  const end = performance.now() + timeout;
  while (!predicate()) { if (performance.now() >= end) throw new Error("Call condition deadline exceeded."); await new Promise(resolve => setTimeout(resolve, 40)); }
}
export async function verifyCalls(a: CallSession, b: CallSession): Promise<void> {
  const [first, second] = [a, b].sort((x, y) => x.getSnapshot().selfMemberId.localeCompare(y.getSnapshot().selfMemberId));
  const firstId = first.getSnapshot().selfMemberId, secondId = second.getSnapshot().selfMemberId;
  await first.requestVerification(secondId);
  try { await until(() => second.getSnapshot().sas.some(s => s.peer.memberId === firstId)); }
  catch { throw new Error(`Call invitation did not progress: ${JSON.stringify([safeCallSummary(first), safeCallSummary(second)])}`); }
  const remote = second.getSnapshot().sas.find(s => s.peer.memberId === firstId)!;
  await second.verificationStep(remote.handle, "accept");
  await until(() => first.getSnapshot().sas.some(s => s.peer.memberId === secondId && s.ready));
  const local = first.getSnapshot().sas.find(s => s.peer.memberId === secondId)!;
  await first.verificationStep(local.handle, "start");
  // A genuine received SAS needs its public accept before emoji can be presented.
  await new Promise(resolve => setTimeout(resolve, 1_200));
  await second.verificationStep(remote.handle, "accept-sas");
  await until(() => !!first.getSnapshot().sas.find(s => s.handle === local.handle)?.emojiIndices && !!second.getSnapshot().sas.find(s => s.handle === remote.handle)?.emojiIndices);
  const lhs = first.getSnapshot().sas.find(s => s.handle === local.handle)!, rhs = second.getSnapshot().sas.find(s => s.handle === remote.handle)!;
  if (JSON.stringify(lhs.emojiIndices) !== JSON.stringify(rhs.emojiIndices) || lhs.emojiIndices?.length !== 7) throw new Error("Genuine public SAS mismatch.");
  await first.verificationStep(local.handle, "confirm"); await second.verificationStep(remote.handle, "confirm");
  await until(() => !!first.getSnapshot().sas.find(s => s.handle === local.handle)?.done && !!second.getSnapshot().sas.find(s => s.handle === remote.handle)?.done);
  await first.admit(secondId); await second.admit(firstId);
}
export async function closeCalls() { for (const call of sessions) await call.close(); sessions.length = 0; anchors.clear(); nativeFailures.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
export async function cleanupCallUsers() { if (ids.length) { await db.delete(community).where(inArray(community.ownerId, ids)); await db.delete(user).where(inArray(user.id, ids)); ids.length = 0; } }
