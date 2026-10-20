import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceHttpError } from "@/lib/voice/http-client";
import { isTransientVoiceError, retryVoiceRequest, transientVoiceReason, VOICE_RETRY_DELAYS_MS, voiceKeyingBudgetMs } from "@/lib/voice/retry";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("voice transient-failure classification", () => {
  it.each([
    [new VoiceHttpError("network"), true], [new VoiceHttpError("timeout"), true],
    [new VoiceHttpError("internal", 500), true], [new VoiceHttpError("protocol", 502), true], [new VoiceHttpError("protocol", 504), true],
    [new VoiceHttpError("protocol", 200), false], [new VoiceHttpError("protocol"), false],
    [new VoiceHttpError("rate_limited", 429), false], [new VoiceHttpError("conflict", 409), false],
    [new VoiceHttpError("unauthorized", 401), false], [new VoiceHttpError("forbidden", 403), false],
    [new VoiceHttpError("aborted"), false], [new Error("native"), false],
  ])("%s → %s", (error, transient) => { expect(isTransientVoiceError(error)).toBe(transient); });
});

describe("retryVoiceRequest", () => {
  it("retries transient failures with increasing backoff and reports the retrying window", async () => {
    const states: boolean[] = [];
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new VoiceHttpError("network")).mockRejectedValueOnce(new VoiceHttpError("protocol", 503)).mockResolvedValue("ok");
    const result = retryVoiceRequest(attempt, new AbortController().signal, active => states.push(active));
    await vi.advanceTimersByTimeAsync(0); expect(attempt).toHaveBeenCalledTimes(1); expect(states).toEqual([true]);
    await vi.advanceTimersByTimeAsync(VOICE_RETRY_DELAYS_MS[0] - 1); expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(VOICE_RETRY_DELAYS_MS[1]); expect(attempt).toHaveBeenCalledTimes(3);
    await expect(result).resolves.toBe("ok"); expect(states).toEqual([true, false]);
  });
  it("never retries non-transient failures", async () => {
    const retrying = vi.fn();
    for (const error of [new VoiceHttpError("rate_limited", 429), new VoiceHttpError("conflict", 409), new Error("native")]) {
      const attempt = vi.fn(async () => { throw error; });
      await expect(retryVoiceRequest(attempt, new AbortController().signal, retrying)).rejects.toBe(error);
      expect(attempt).toHaveBeenCalledOnce();
    }
    expect(retrying).not.toHaveBeenCalled();
  });
  it("stops after the bounded retry count with the last original failure", async () => {
    const states: boolean[] = [], attempt = vi.fn(async () => { throw new VoiceHttpError("timeout"); });
    const result = retryVoiceRequest(attempt, new AbortController().signal, active => states.push(active)).catch(error => error);
    await vi.advanceTimersByTimeAsync(VOICE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0) + 60_000);
    expect(await result).toMatchObject({ code: "timeout" });
    expect(attempt).toHaveBeenCalledTimes(VOICE_RETRY_DELAYS_MS.length + 1); expect(states).toEqual([true, false]);
  });
  it("a failure thrown by the attempt's own currency/budget check ends retrying", async () => {
    let calls = 0;
    const attempt = vi.fn(async () => { if (calls++ === 0) throw new VoiceHttpError("network"); throw new Error("lease-expired"); });
    const result = retryVoiceRequest(attempt, new AbortController().signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ message: "lease-expired" }); expect(attempt).toHaveBeenCalledTimes(2);
  });
  it("abort during backoff rejects with the original failure and issues no further attempt", async () => {
    const abort = new AbortController(), failure = new VoiceHttpError("network"), states: boolean[] = [];
    const attempt = vi.fn(async () => { throw failure; });
    const result = retryVoiceRequest(attempt, abort.signal, active => states.push(active)).catch(error => error);
    await vi.advanceTimersByTimeAsync(100); abort.abort();
    expect(await result).toBe(failure);
    await vi.advanceTimersByTimeAsync(60_000); expect(attempt).toHaveBeenCalledOnce(); expect(states).toEqual([true, false]);
  });
});

describe("voice media keying budget", () => {
  it("grows per remote peer, is bounded, and is longer than the former ten seconds", () => {
    expect(voiceKeyingBudgetMs(0)).toBe(20_000);
    expect(voiceKeyingBudgetMs(1)).toBe(23_000);
    expect(voiceKeyingBudgetMs(7)).toBe(41_000);
    expect(voiceKeyingBudgetMs(100)).toBe(45_000);
    expect(voiceKeyingBudgetMs(-1)).toBe(20_000);
  });
});

describe("transient end reasons", () => {
  it("names network, timeout and server problems, and nothing else", () => {
    expect(transientVoiceReason(new VoiceHttpError("network"))).toBe("network");
    expect(transientVoiceReason(new VoiceHttpError("timeout"))).toBe("timeout");
    expect(transientVoiceReason(new VoiceHttpError("protocol", 502))).toBe("internal");
    expect(transientVoiceReason(new VoiceHttpError("internal", 500))).toBe("internal");
    expect(transientVoiceReason(new VoiceHttpError("rate_limited", 429))).toBeUndefined();
    expect(transientVoiceReason(new Error("x"))).toBeUndefined();
  });
});
