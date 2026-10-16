import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as nativeFactory from "@/lib/voice/crypto-owner";
import type { VoiceContextProposal } from "@/lib/voice/epoch-agreement";
import { VOICE_CONTROL_EVENT, voiceControlParty } from "@/lib/voice/owner-control";
import { callHttpFixture, cleanupCallUsers, closeCalls, startCall, until, verifyCalls } from "./fixtures/voice-call-http";

afterEach(closeCalls);
afterAll(cleanupCallUsers);
describe("unactivated CallSession with actual cookie HTTP / PostgreSQL / public native Owners", () => {
  it("keeps asynchronous local consent thin, continues real SAS/ACK, then explicitly retries a genuine three-peer agreement", async () => {
    const fixture = await callHttpFixture(3);
    const issued = new Map<string, { port: nativeFactory.VoiceProductOwnerPort; proposal?: VoiceContextProposal }>();
    const create = nativeFactory.createVoiceProductOwner;
    vi.spyOn(nativeFactory, "createVoiceProductOwner").mockImplementation(async options => {
      const port = await create(options), observed: { port: nativeFactory.VoiceProductOwnerPort; proposal?: VoiceContextProposal } = { port };
      issued.set(options.accountId, observed);
      // Observe genuine public return values only; native methods/results are unchanged.
      return Object.freeze({ ...port, createContextOffer: async () => { const offer = await port.createContextOffer(); observed.proposal = offer.proposal; return offer; } });
    });
    for (const account of fixture.accounts) await startCall(account);
    await until(() => fixture.accounts.every(account => account.call!.getSnapshot().roster.length === 3), 15_000);
    const [a, b, c] = fixture.accounts.map(account => account.call!).sort((x, y) => x.getSnapshot().selfMemberId.localeCompare(y.getSnapshot().selfMemberId));
    await verifyCalls(a, b); await verifyCalls(a, c);
    await a.confirmFullRoster();
    await until(() => b.getSnapshot().localConsentPending && c.getSnapshot().localConsentPending);
    expect(a.getSnapshot().state).not.toBe("agreed"); expect(b.getSnapshot().admittedMemberIds).toHaveLength(1);
    expect(b.getSnapshot()).not.toHaveProperty("proposal"); expect(b.getSnapshot()).not.toHaveProperty("ref");
    await verifyCalls(b, c);
    await until(() => a.getSnapshot().state === "retry-required");
    const sends = fixture.accounts.flatMap(account => account.calls).filter(call => call.kind === "send").length;
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(fixture.accounts.flatMap(account => account.calls).filter(call => call.kind === "send")).toHaveLength(sends);
    await b.confirmFullRoster(); await c.confirmFullRoster(); await a.confirmFullRoster();
    await until(() => [a, b, c].every(call => call.getSnapshot().state === "agreed"));
    expect(fixture.writes).not.toHaveBeenCalled();
    const leaderAccount = fixture.accounts.find(account => account.call === a)!, leader = issued.get(leaderAccount.accountId)!, proposal = leader.proposal!;
    const sender = voiceControlParty(a.getSnapshot().roster.find(member => member.memberId === a.getSnapshot().selfMemberId)!), recipient = voiceControlParty(b.getSnapshot().roster.find(member => member.memberId === b.getSnapshot().selfMemberId)!);
    await leader.port.sendControl({ version: 1, purpose: VOICE_CONTROL_EVENT, kind: "material", callId: proposal.callId, generation: proposal.generation, epochId: proposal.epochId, proposalSequence: proposal.sequence, sender, recipient, publisher: sender, audience: [...proposal.audience], keyId: crypto.randomUUID(), reference: crypto.randomUUID(), transaction: crypto.randomUUID(), material: Buffer.alloc(32, 9).toString("base64") });
    await until(() => b.getSnapshot().state === "ended");
    expect(b.getSnapshot().error).toBe("unsupported-media");
    for (const account of fixture.accounts) {
      expect(account.calls.some(call => call.kind === "ack")).toBe(true);
      const starts = account.calls.map(call => call.start);
      for (const start of starts) expect(starts.filter(time => time > start - 60_000 && time <= start).length).toBeLessThanOrEqual(180);
      expect(account.calls.some(call => call.status === 429)).toBe(false);
    }
  }, 120_000);

  it("keeps a newer installed agreement after a genuine delayed lower offer, then agrees fresh current traffic", async () => {
    const { accounts } = await callHttpFixture(2);
    const issued = new Map<string, { port: nativeFactory.VoiceProductOwnerPort; proposals: VoiceContextProposal[] }>();
    const create = nativeFactory.createVoiceProductOwner;
    vi.spyOn(nativeFactory, "createVoiceProductOwner").mockImplementation(async options => {
      const port = await create(options), observed = { port, proposals: [] as VoiceContextProposal[] };
      issued.set(options.accountId, observed);
      return Object.freeze({ ...port, createContextOffer: async () => { const offer = await port.createContextOffer(); observed.proposals.push(offer.proposal); return offer; } });
    });
    for (const account of accounts) await startCall(account);
    await until(() => accounts.every(account => account.call!.getSnapshot().roster.length === 2));
    const [leaderAccount, otherAccount] = [...accounts].sort((a, b) => a.call!.getSnapshot().selfMemberId.localeCompare(b.call!.getSnapshot().selfMemberId));
    const leader = leaderAccount.call!, receiver = otherAccount.call!, observer = issued.get(leaderAccount.accountId)!;
    await verifyCalls(leader, receiver); await receiver.confirmFullRoster(); await leader.confirmFullRoster();
    await until(() => leader.getSnapshot().state === "agreed" && receiver.getSnapshot().state === "agreed");
    const first = observer.proposals[0];
    let release!: () => void, held = false;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    leaderAccount.before = async body => { if (!held && body.action === "crypto" && body.input.request?.kind === "send") { held = true; await delayed; } };
    const sender = voiceControlParty(leader.getSnapshot().roster.find(member => member.memberId === leader.getSnapshot().selfMemberId)!), recipient = voiceControlParty(receiver.getSnapshot().roster.find(member => member.memberId === receiver.getSnapshot().selfMemberId)!);
    const oldDelivery = observer.port.sendContextControl({ version: 1, purpose: VOICE_CONTROL_EVENT, kind: "context-offer", callId: first.callId, generation: first.generation, epochId: first.epochId, sequence: first.sequence, reference: first.reference, transaction: first.reference, audience: [...first.audience], leader: first.leader, sender, recipient }).catch(error => error);
    await until(() => held);
    await leader.confirmFullRoster();
    await until(() => observer.proposals.length === 2 && leader.getSnapshot().state === "agreed" && receiver.getSnapshot().state === "agreed");
    const installed = receiver.getSnapshot(), acks = otherAccount.calls.filter(trace => trace.kind === "ack").length;
    release(); await oldDelivery;
    await until(() => otherAccount.calls.filter(trace => trace.kind === "ack").length > acks);
    expect(receiver.getSnapshot()).toEqual(installed);
    expect(receiver.getSnapshot().state).toBe("agreed");
    await new Promise(resolve => setTimeout(resolve, 1_050));
    await leader.confirmFullRoster();
    await until(() => observer.proposals.length === 3 && leader.getSnapshot().state === "agreed" && receiver.getSnapshot().state === "agreed");
    expect(observer.proposals.map(proposal => proposal.sequence)).toEqual([1, 2, 3]);
    expect(otherAccount.calls.some(trace => trace.status === 429)).toBe(false);
  }, 90_000);

  it("discovers real HTTP409 first, transitions once, exchanges fresh peer SAS, preserves exact admission on a later generation", async () => {
    const { accounts, held } = await callHttpFixture(3);
    const a = await startCall(accounts[0]), original = a.getSnapshot().generation;
    const b = await startCall(accounts[1]);
    await until(() => a.getSnapshot().generation > original && a.getSnapshot().roster.length === 2);
    const firstConflict = accounts[0].calls.findIndex(call => call.status === 409), firstHeartbeat = accounts[0].calls.findIndex(call => call.action === "heartbeat");
    expect(firstConflict).toBeGreaterThanOrEqual(0); expect(firstHeartbeat).toBeGreaterThan(firstConflict);
    await verifyCalls(a, b);
    const admitted = [...a.getSnapshot().admittedMemberIds];
    await startCall(accounts[2]);
    await until(() => a.getSnapshot().roster.length === 3);
    expect(a.getSnapshot().admittedMemberIds).toEqual(admitted);
    expect(a.getSnapshot().state).not.toBe("agreed");
    accounts[0].valid = false;
    expect(() => a.checkCurrent()).toThrow("Actual session replaced");
    await a.close(); expect(a.getSnapshot().state).toBe("ended"); expect(held.has(`opendiscord.voice:${accounts[0].accountId}`)).toBe(false);
    expect(accounts[0].calls.filter(call => call.action === "leave")).toHaveLength(1);
  }, 90_000);

  it("a same-generation409 stays fatal and releases guard with no transparent retry", async () => {
    const { accounts, held } = await callHttpFixture(1);
    const call = await startCall(accounts[0]);
    accounts[0].before = async body => body.action === "crypto" && body.input.request?.kind === "sync" ? Response.json({ code: "conflict" }, { status: 409 }) : undefined;
    await until(() => call.getSnapshot().state === "ended"); await call.close();
    expect(accounts[0].calls.filter(trace => trace.status === 409)).toHaveLength(1);
    expect(accounts[0].calls.filter(trace => trace.action === "heartbeat")).toHaveLength(1);
    expect(held.size).toBe(0);
  }, 20_000);

  it("429 closes without automatic retry", async () => {
    const { accounts } = await callHttpFixture(1);
    const call = await startCall(accounts[0]);
    accounts[0].before = async body => body.action === "crypto" ? Response.json({ code: "rate_limited" }, { status: 429 }) : undefined;
    await until(() => call.getSnapshot().state === "ended"); await call.close();
    expect(accounts[0].calls.filter(trace => trace.status === 429)).toHaveLength(1);
  }, 20_000);
});
