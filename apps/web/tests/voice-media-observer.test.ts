import { describe, expect, it, vi } from "vitest";
import { legitimateStartupConflict, observeMediaGrant } from "../e2e/fixtures/voice-media-observer";

const metadata = { epoch: "initial" as const, pageIndex: 0, status: 200 };
describe("media CI observation results (no HTTP/native/ACK acceptance)", () => {
  it("immediately handles async body rejection, keeps it failed when awaited later and never invokes verifier", async () => {
    const verify = vi.fn();
    const observation = observeMediaGrant({ ...metadata, finished: async () => null, failure: () => null, read: async () => { throw new Error("sensitive raw protocol details"); }, verify });
    // Rejection occurs before the caller reaches its barrier; no floating rejection.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(await observation).toEqual({ ...metadata, finished: true, requestFailure: "none", errorStage: "body" });
    expect(verify).not.toHaveBeenCalled();
  });
  it("requires real completion and preserves aborted200 as a hard failed result", async () => {
    const read = vi.fn(), verify = vi.fn();
    expect(await observeMediaGrant({ ...metadata, finished: async () => new Error("aborted"), failure: () => ({ errorText: "net::ERR_ABORTED" }), read, verify })).toEqual({ ...metadata, finished: false, requestFailure: "aborted", errorStage: "finished" });
    expect(read).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
  });
  it("verifies every successful grant, persists only allowlisted claims and retains verification failures", async () => {
    const verify = vi.fn(async () => ({ publish: false, subscribe: true, data: false }));
    const input = { ...metadata, finished: async () => null, failure: () => null, read: async () => ({ token: "disposable-test-verifier-input", sources: [] }), verify };
    const result = await observeMediaGrant(input);
    expect(result).toEqual({ ...metadata, finished: true, requestFailure: "none", errorStage: "none", grant: { sources: [], publish: false, subscribe: true, data: false } });
    expect(result).not.toHaveProperty("token"); expect(verify).toHaveBeenCalledExactlyOnceWith("disposable-test-verifier-input");
    verify.mockRejectedValueOnce(new Error("raw signature detail"));
    expect(await observeMediaGrant(input)).toMatchObject({ errorStage: "verify" });
  });
  it("bounds a missing completion without converting it into a successful grant", async () => {
    const result = await observeMediaGrant({ ...metadata, finished: () => new Promise(() => {}), failure: () => null, read: vi.fn(), verify: vi.fn() }, 5);
    expect(result.errorStage).toBe("timeout"); expect(result.grant).toBeUndefined();
  });
  it("allows only exact startup crypto409 plus proven newer generation", () => {
    const input = { method: "POST", path: "/api/voice/control", action: "crypto", status: 409, startup: true, expectedGeneration: 1, currentGeneration: 3 };
    expect(legitimateStartupConflict(input)).toBe(true);
    for (const change of [{ method: "GET" }, { path: "/api/other" }, { action: "token" }, { status: 403 }, { startup: false }, { currentGeneration: 1 }, { expectedGeneration: 0 }]) expect(legitimateStartupConflict({ ...input, ...change })).toBe(false);
  });
});
