import { writeFile } from "node:fs/promises";
import type { TestInfo } from "@playwright/test";

export type VoiceProductObservationStage = "body" | "verify" | "result" | "diagnostic" | "cleanup";
export type VoiceProductObservation<T> = Readonly<
  { ok: true; value: T } | { ok: false; stage: VoiceProductObservationStage; reason: "timeout" | "failed" }
>;

/** Detached observation only: no replay, native operation replacement or late result mutation. */
export function observeVoiceProductResult<T>(
  operation: (checkpoint: (stage: VoiceProductObservationStage) => void) => Promise<T>,
  { timeoutMs = 5000, stage: initialStage = "body" }: { timeoutMs?: number; stage?: VoiceProductObservationStage } = {},
): Promise<VoiceProductObservation<T>> {
  return new Promise(resolve => {
    let settled = false, stage = initialStage;
    const finish = (result: VoiceProductObservation<T>) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(Object.freeze(result));
    };
    const checkpoint = (next: VoiceProductObservationStage) => {
      if (settled) throw new Error("Voice product observation already settled.");
      stage = next;
    };
    const timer = setTimeout(() => finish({ ok: false, stage, reason: "timeout" }), timeoutMs);
    // Install both fulfillment/rejection handlers immediately, including synchronous operation errors.
    void Promise.resolve().then(() => operation(checkpoint)).then(
      value => finish({ ok: true, value }),
      () => finish({ ok: false, stage, reason: "failed" }),
    );
  });
}

/** Diagnostics must never prevent the already-owned browser contexts from closing. */
export async function withVoiceProductCleanup<T>(diagnose: () => Promise<T>, close: () => Promise<void>): Promise<T> {
  try { return await diagnose(); }
  finally { await close(); }
}

/** The workflow uploads this actual file even if attaching it to the test result fails. */
export function writeVoiceProductEvidence(info: Pick<TestInfo, "outputPath" | "attach">, name: "voice-product-evidence" | "voice-product-evidence-final", body: string) {
  return observeVoiceProductResult(async checkpoint => {
    const path = info.outputPath(`${name}.json`);
    await writeFile(path, body, { mode: 0o600 });
    checkpoint("diagnostic");
    await info.attach(name, { path, contentType: "application/json" });
  }, { timeoutMs: 2000, stage: "diagnostic" });
}
