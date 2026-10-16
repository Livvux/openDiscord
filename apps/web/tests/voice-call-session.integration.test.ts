import { afterAll, afterEach, describe, expect, it } from "vitest";
import { callHttpFixture, cleanupCallUsers, closeCalls, startCall, until, verifyCalls } from "./fixtures/voice-call-http";

afterEach(closeCalls);
afterAll(cleanupCallUsers);
describe("unactivated CallSession with actual cookie HTTP / PostgreSQL / public native Owners", () => {
  it("keeps asynchronous local consent thin, continues real SAS/ACK, then explicitly retries a genuine three-peer agreement", async () => {
    const fixture = await callHttpFixture(3);
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
    for (const account of fixture.accounts) {
      expect(account.calls.some(call => call.kind === "ack")).toBe(true);
      const starts = account.calls.map(call => call.start);
      for (const start of starts) expect(starts.filter(time => time > start - 60_000 && time <= start).length).toBeLessThanOrEqual(180);
      expect(account.calls.some(call => call.status === 429)).toBe(false);
    }
  }, 120_000);

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

  it("429 closes without automatic retry, and delayed join spends the original lease", async () => {
    const { accounts } = await callHttpFixture(1);
    const call = await startCall(accounts[0]);
    accounts[0].before = async body => body.action === "crypto" ? Response.json({ code: "rate_limited" }, { status: 429 }) : undefined;
    await until(() => call.getSnapshot().state === "ended"); await call.close();
    expect(accounts[0].calls.filter(trace => trace.status === 429)).toHaveLength(1);
  }, 20_000);
});
