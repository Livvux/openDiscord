import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeVoiceProductResult, withVoiceProductCleanup } from "../e2e/fixtures/voice-product-results";

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
describe("bounded genuine Voice product acceptance observation", () => {
  it("a never-settling body fails at its deadline and closes contexts; late body cannot start verification or replay", async () => {
    const body = gate<unknown>(), verify = vi.fn(async () => "verified"), close = vi.fn(async () => {}), read = vi.fn(() => body.promise);
    const result = observeVoiceProductResult(async checkpoint => { await read(); checkpoint("verify"); return verify(); });
    const cleanup = withVoiceProductCleanup(() => result, close);
    await vi.advanceTimersByTimeAsync(5000);
    const failed = await cleanup;
    expect(failed).toEqual({ ok: false, stage: "body", reason: "timeout" });
    expect(Object.isFrozen(failed)).toBe(true); expect(close).toHaveBeenCalledOnce();
    body.resolve({}); await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(failed); expect(read).toHaveBeenCalledOnce(); expect(verify).not.toHaveBeenCalled();
  });
  it("a never-settling verifier remains a hard failed immutable result after late success, and cleanup proceeds", async () => {
    const verification = gate<string>(), close = vi.fn(async () => {}), verify = vi.fn(() => verification.promise);
    const result = observeVoiceProductResult(async checkpoint => { checkpoint("verify"); const value = await verify(); checkpoint("result"); return value; });
    const cleanup = withVoiceProductCleanup(() => result, close);
    await vi.advanceTimersByTimeAsync(5000);
    const failed = await cleanup;
    expect(failed).toEqual({ ok: false, stage: "verify", reason: "timeout" });
    verification.resolve("late success"); await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(failed); expect(verify).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
  it("handles body/signature rejection immediately and preserves it as a hard result", async () => {
    for (const stage of ["body", "verify"] as const) {
      const result = await observeVoiceProductResult(async checkpoint => { checkpoint(stage); throw new Error("Private response details must not escape."); });
      expect(result).toEqual({ ok: false, stage, reason: "failed" }); expect(Object.isFrozen(result)).toBe(true);
    }
  });
  it("closes contexts even when diagnostic collection throws", async () => {
    const close = vi.fn(async () => {});
    await expect(withVoiceProductCleanup(async () => { throw new Error("diagnostic failed"); }, close)).rejects.toThrow("diagnostic failed");
    expect(close).toHaveBeenCalledOnce();
  });
});
