import { writeFile } from "node:fs/promises";
import type { TestInfo } from "@playwright/test";

export function classifyVoiceProductConsole(text: string, location: string, pageUrl: string) {
  const status = /^Failed to load resource: the server responded with a status of ([45]\d{2}) \([^\r\n]*\)$/.exec(text);
  let endpoint: "voice-control" | "app-script" | "other" = "other";
  try {
    const url = new URL(location), page = new URL(pageUrl);
    if (url.origin === page.origin) {
      if (url.pathname === "/api/voice/control") endpoint = "voice-control";
      else if (url.pathname.startsWith("/_next/static/")) endpoint = "app-script";
    }
  } catch { /* Missing console locations remain unclassified. */ }
  return { kind: status ? "http-resource" as const : "other" as const, status: status ? Number(status[1]) : null, endpoint };
}

export type VoiceProductPhase = "verifying" | "waiting" | "consent-pending" | "negotiating" | "retry-required" | "preparing" | "ready" | "stopped" | "unknown";
export type VoiceProductReason = "none" | "control-failed" | "lease-expired" | "binding-changed" | "session-changed" | "provider-unmounted" | "context-expired" | "not-ready" | "budget-exhausted" | "generation-conflict" | "retirement-conflict" | "media-initialization-failed" | "other";
export type VoiceProductCheckpoint = "initial-consent" | "delayed-consent" | "waiting-expiry" | "responder-retry" | "leader-retry" | "media-ready";

/** Runs in the page: only fixed enums leave the DOM, never source status/alert text. */
export function readVoiceProductPresentation(elements: Pick<Element, "getAttribute" | "textContent">[]): { phase: VoiceProductPhase; reason: VoiceProductReason } {
  const phases = new Map<string, VoiceProductPhase>([
    ["Verify every participant, then admit them separately.", "verifying"],
    ["Waiting for participant setup and audience consent.", "waiting"],
    ["Waiting for your full audience consent.", "consent-pending"],
    ["Agreeing the full audience…", "negotiating"],
    ["Audience attempt expired. Review everyone and retry.", "retry-required"],
    ["Preparing encrypted media…", "preparing"],
    ["Encrypted voice ready — microphone off", "ready"],
    ["Encrypted voice ready — microphone on", "ready"],
    ["Voice stopped. Join again to start a fresh call.", "stopped"],
  ]);
  const reasons: Exclude<VoiceProductReason, "none" | "other">[] = ["control-failed", "lease-expired", "binding-changed", "session-changed", "provider-unmounted", "context-expired", "not-ready", "budget-exhausted", "generation-conflict", "retirement-conflict", "media-initialization-failed"];
  const templates = new Map<string, VoiceProductReason>([
    ["The other participant is not ready yet. Wait, then explicitly retry this action.", "not-ready"],
    ["Voice is busy. Wait a moment before retrying.", "budget-exhausted"],
  ]);
  for (const reason of reasons) {
    templates.set(`Voice stopped (${reason}). Join again when ready.`, reason);
    templates.set(`Voice: ${reason}. Review the call status before retrying.`, reason);
  }
  const statuses = new Set<VoiceProductPhase>(), alerts = new Set<VoiceProductReason>();
  for (const element of elements) {
    const role = element.getAttribute("role"), text = element.textContent?.trim() ?? "";
    if (role === "status" && phases.has(text)) statuses.add(phases.get(text)!);
    if (role === "alert" && text) alerts.add(templates.get(text) ?? "other");
  }
  return { phase: statuses.size === 1 ? [...statuses][0] : "unknown", reason: alerts.size === 0 ? "none" : alerts.size === 1 ? [...alerts][0] : "other" };
}

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
