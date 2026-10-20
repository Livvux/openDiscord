import { VoiceHttpError } from "./http-client";

/**
 * Backoff before each retry of one request; length is the retry cap (eight attempts, ~19.5 s of
 * waiting). This is longer than a typical blip but shorter than the 30 s lease, so a network that
 * stays down ends the call through the lease (every attempt re-checks it) rather than by count.
 */
export const VOICE_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 4_000, 4_000, 4_000] as const;
/**
 * Join: with a fresh nonce/device, the only 409 is this browser's previous enrollment whose leave
 * was lost (the account Web Lock rules out a concurrent owner). It clears when that lease
 * (at most 30 s) expires, so these delays add up past one lease. The same nonce makes a lost
 * successful join response replay the existing enrollment instead of creating a second one.
 */
export const VOICE_JOIN_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 8_000, 8_000] as const;
export const isRetryableVoiceJoinError = (error: unknown): boolean => isTransientVoiceError(error) || (error instanceof VoiceHttpError && error.code === "conflict" && error.status === 409);
const KEYING_BASE_MS = 20_000, KEYING_PER_REMOTE_MS = 3_000, KEYING_MAX_MS = 45_000;

/**
 * Only failures where the request may not have reached the server or the server/proxy
 * failed before answering. Every retried voice action is idempotent server-side: heartbeat
 * renews the lease, sync re-reads unacknowledged mail, ACK deletes up to a delivered cursor,
 * query is read-only and every other crypto request replays its stored receipt by request ID.
 * 4xx (including 409 and 429), aborts and malformed 2xx answers are never retried.
 */
export function isTransientVoiceError(error: unknown): boolean {
  if (!(error instanceof VoiceHttpError)) return false;
  if (error.code === "network" || error.code === "timeout") return true;
  // A gateway's HTML 502/503/504 page fails JSON parsing, so it arrives as "protocol" with its status.
  return (error.code === "internal" || error.code === "protocol") && error.status !== undefined && error.status >= 500 && error.status <= 599;
}

/** End reason for an exhausted transient failure: a gateway 5xx page reads as a server problem. */
export function transientVoiceReason(error: unknown): "network" | "timeout" | "internal" | undefined {
  if (!isTransientVoiceError(error)) return undefined;
  const { code } = error as VoiceHttpError;
  return code === "network" || code === "timeout" ? code : "internal";
}

/** Media keying budget from installation: sequential per-peer native sends scale with peers. Never resets. */
export function voiceKeyingBudgetMs(remotes: number): number {
  return Math.min(KEYING_MAX_MS, KEYING_BASE_MS + KEYING_PER_REMOTE_MS * Math.max(0, remotes));
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); reject(new VoiceHttpError("aborted")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", done); resolve(); }, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

/**
 * Runs `attempt` again after a transient failure, with bounded backoff. Each attempt must
 * itself re-check call currency and charge the shared request budget, so retries never
 * outlive the lease or bypass the rate-limit budget. `retrying` reports pending backoff.
 */
export async function retryVoiceRequest<T>(attempt: () => Promise<T>, signal: AbortSignal, retrying: (active: boolean) => void = () => {}, delays: readonly number[] = VOICE_RETRY_DELAYS_MS, retryable: (error: unknown) => boolean = isTransientVoiceError): Promise<T> {
  for (let index = 0; ; index++) {
    try {
      const value = await attempt();
      if (index > 0) retrying(false);
      return value;
    } catch (error) {
      if (index >= delays.length || !retryable(error) || signal.aborted) { if (index > 0) retrying(false); throw error; }
      if (index === 0) retrying(true);
      try { await wait(delays[index], signal); } catch { retrying(false); throw error; }
    }
  }
}
