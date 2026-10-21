import { writeFile } from "node:fs/promises";
import type { TestInfo } from "@playwright/test";

export function classifyVoiceProductConsole(text: string, location: string, pageUrl: string) {
  const status = /^Failed to load resource: the server responded with a status of ([45]\d{2}) \([^\r\n]*\)$/.exec(text);
  let endpoint: "voice-control" | "app-script" | "turnstile" | "other" = "other";
  try {
    const url = new URL(location), page = new URL(pageUrl);
    if (url.origin === page.origin) {
      if (url.pathname === "/api/voice/control") endpoint = "voice-control";
      else if (url.pathname.startsWith("/_next/static/")) endpoint = "app-script";
    } else if (url.origin === "https://challenges.cloudflare.com") endpoint = "turnstile";
  } catch { /* Missing console locations remain unclassified. */ }
  const code = /^DataChannel error on (?:lossy|reliable):/.test(text) ? "data-channel-error"
    : /^Unknown DataChannel error on (?:lossy|reliable)/.test(text) ? "data-channel-unknown"
    : /^publisher data channel '(?:LOSSY|RELIABLE|DATA_TRACK_LOSSY)' closed unexpectedly/.test(text) ? "data-channel-closed"
    : /^error sending signal message/.test(text) ? "signal-send"
    : /^cannot send signal request before connected, type:/.test(text) ? "signal-unconnected"
    : /^error reading from signal stream/.test(text) ? "signal-read"
    : /^unable to subscribe because MediaStreamTrack is ended\. Do not call MediaStreamTrack\.stop\(\)/.test(text) ? "ended-track-subscription"
    : /^unable to set (?:offer|answer|pranswer|rollback)(?:\s|$)/.test(text) ? "session-description"
    : /^missing track resolver for /.test(text) ? "missing-track-resolver"
    : /^unsupported data type(?:\s|$)/.test(text) ? "unsupported-data"
    : /^Received encrypted packet but E2EE not set up$/.test(text) ? "missing-e2ee"
    : /^websocket error/.test(text) ? "signal-socket"
    : /^WebSocket is already in CLOSING or CLOSED state/.test(text) ? "closed-transport"
    : /^Tried to add a track|^could not find published track/.test(text) ? "missing-track"
    : /^(?:NotFoundError: )?Failed to execute 'removeChild'/.test(text) ? "dom-removal"
    : /Minified React error #\d+/.test(text) ? "react"
    : /^(?:AbortError: )?The play\(\) request was interrupted/.test(text) ? "playback-interrupted"
    : /^Encryption downgrade refused|^Unadmitted media identity|^Native encryption worker failed|^e2ee worker encountered an error:|^failed to set up transform|^error while encrypting|^DataCryptor decryption failed|^could not re-establish transform/.test(text) ? "worker"
    : "other";
  return { kind: status ? "http-resource" as const : "other" as const, status: status ? Number(status[1]) : null, endpoint, code };
}

/** Unknown-class evidence only: first six words; any word with digits, slashes, quotes or over 24 chars (IDs, URLs, JWTs, SDP) is masked. */
export function fingerprintVoiceProductConsole(text: string) {
  return text.split(/\s+/, 6).map(word => /^[A-Za-z][A-Za-z'.:,()-]{0,23}$/.test(word) ? word : "#").join(" ");
}

/** Runs in the console argument's realm; returns no message, identifiers or arbitrary properties. */
export function readVoiceProductConsoleArgument(value: unknown) {
  const outer = value !== null && typeof value === "object" ? value : {};
  const inner = "error" in outer && outer.error !== null && typeof outer.error === "object" ? outer.error : outer;
  const detail = "errorDetail" in inner ? inner.errorDetail : undefined;
  const cause = "sctpCauseCode" in inner ? inner.sctpCauseCode : undefined;
  const name = "name" in inner ? inner.name : undefined;
  // Pinned LiveKit ConnectionErrorReason values. Diagnostics only: no new error exemption.
  const reasons = ["not-allowed", "server-unreachable", "internal", "cancelled", "leave-request", "timeout", "websocket", "service-not-found"];
  const reason = "reason" in inner ? inner.reason : undefined;
  return {
    detail: detail === "sctp-failure" || detail === "data-channel-failure" || detail === "dtls-failure" ? detail : detail === undefined ? "none" : "other",
    cause: typeof cause === "number" && Number.isInteger(cause) && cause >= 0 && cause <= 65535 ? cause : null,
    name: typeof name === "string" && ["Error", "RTCError", "TypeError", "InvalidStateError", "NotFoundError", "OperationError", "AbortError", "ConnectionError"].includes(name) ? name : name === undefined ? "none" : "other",
    connectionReason: name === "ConnectionError" && typeof reason === "number" && Number.isInteger(reason) && reason >= 0 && reason < reasons.length ? reasons[reason] : null,
  };
}

export type VoiceProductPhase = "verifying" | "waiting" | "consent-pending" | "negotiating" | "retry-required" | "preparing" | "ready" | "stopped" | "unknown";
export type VoiceProductReason = "none" | "control-failed" | "lease-expired" | "binding-changed" | "session-changed" | "provider-unmounted" | "context-expired" | "not-ready" | "budget-exhausted" | "generation-conflict" | "retirement-conflict" | "media-initialization-failed" | "other";
export type VoiceProductCheckpoint = "initial-consent" | "delayed-consent" | "waiting-expiry" | "responder-retry" | "leader-retry" | "media-ready";

/** Runs in the page: only fixed enums leave the DOM, never source status/alert text. */
export function readVoiceProductPresentation(elements: Pick<Element, "getAttribute" | "textContent">[]): { phase: VoiceProductPhase; reason: VoiceProductReason } {
  const phases = new Map<string, VoiceProductPhase>([
    ["Compare symbols with each participant, then admit them.", "verifying"],
    ["Waiting for others to join…", "verifying"],
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
    // Ended statuses carry a human reason after a fixed prefix; only the phase leaves the page.
    if (role === "status" && (phases.has(text) || /^Voice stopped(: | \([a-z_-]+\)\. Rejoin when ready\.$)/.test(text))) statuses.add(phases.get(text) ?? "stopped");
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
