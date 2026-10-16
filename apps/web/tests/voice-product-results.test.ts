import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeVoiceProductResult, withVoiceProductCleanup, writeVoiceProductEvidence } from "../e2e/fixtures/voice-product-results";

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
  it.each([false, true])("retains the actual allowlisted diagnostic file when attachment fails: %s", async failAttachment => {
    const directory = await mkdtemp(join(tmpdir(), "voice-product-evidence-"));
    try {
      const path = join(directory, "voice-product-evidence-final.json"), body = JSON.stringify({ stage: "native-sas-and-admission", grantCount: 0 });
      const close = vi.fn(async () => {});
      const attach = vi.fn(async () => { if (failAttachment) throw new Error("Attachment unavailable."); });
      const result = await withVoiceProductCleanup(() => writeVoiceProductEvidence({ outputPath: (...segments) => join(directory, ...segments), attach }, "voice-product-evidence-final", body), close);
      expect(await readFile(path, "utf8")).toBe(body);
      expect(attach).toHaveBeenCalledWith("voice-product-evidence-final", { path, contentType: "application/json" });
      expect(result.ok).toBe(!failAttachment); expect(close).toHaveBeenCalledOnce();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
