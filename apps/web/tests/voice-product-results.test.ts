import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyVoiceProductConsole, fingerprintVoiceProductConsole, readVoiceProductConsoleArgument, observeVoiceProductResult, readVoiceProductPresentation, withVoiceProductCleanup, writeVoiceProductEvidence, type VoiceProductCheckpoint, type VoiceProductPhase } from "../e2e/fixtures/voice-product-results";

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
      const path = join(directory, "voice-product-evidence-final.json");
      const snapshot = readVoiceProductPresentation([element("status", "Waiting for your full audience consent."), element("alert", "private-error-detail")]);
      const phaseCheckpoints: Partial<Record<VoiceProductCheckpoint, typeof snapshot[]>> = { "initial-consent": [snapshot, snapshot, snapshot] };
      const body = JSON.stringify({ stage: "initial-consent", leaderRetryDispatched: false, phaseCheckpoints, grantCount: 0 });
      const close = vi.fn(async () => {});
      const attach = vi.fn(async () => { if (failAttachment) throw new Error("Attachment unavailable."); });
      const result = await withVoiceProductCleanup(() => writeVoiceProductEvidence({ outputPath: (...segments) => join(directory, ...segments), attach }, "voice-product-evidence-final", body), close);
      expect(await readFile(path, "utf8")).toBe(body);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(body).not.toContain("private-error-detail");
      expect(JSON.parse(body)).toMatchObject({ leaderRetryDispatched: false, phaseCheckpoints: { "initial-consent": Array(3).fill({ phase: "consent-pending", reason: "other" }) } });
      expect(attach).toHaveBeenCalledWith("voice-product-evidence-final", { path, contentType: "application/json" });
      expect(result.ok).toBe(!failAttachment); expect(close).toHaveBeenCalledOnce();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

function element(role: string, textContent: string): Pick<Element, "getAttribute" | "textContent"> {
  return { getAttribute: name => name === "role" ? role : null, textContent };
}
describe("fixed public Voice phase and reason diagnostics", () => {
  const phases: [string, VoiceProductPhase][] = [
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
    ["Voice stopped: you no longer have permission to use this call.", "stopped"],
    ["Voice stopped (some-reason). Rejoin when ready.", "stopped"],
  ];
  it.each(phases)("maps exact public status %s only to %s", (text, phase) => {
    expect(readVoiceProductPresentation([element("status", text), element("status", text)])).toEqual({ phase, reason: "none" });
  });
  it.each(["control-failed", "lease-expired", "binding-changed", "session-changed", "provider-unmounted", "context-expired", "not-ready", "budget-exhausted", "generation-conflict", "retirement-conflict", "media-initialization-failed"])("maps both exact public error templates for %s", reason => {
    for (const text of [`Voice: ${reason}. Review the call status before retrying.`, `Voice stopped (${reason}). Join again when ready.`]) {
      expect(readVoiceProductPresentation([element("alert", text)])).toEqual({ phase: "unknown", reason });
    }
  });
  it("maps the existing bounded retry messages without returning their text", () => {
    expect(readVoiceProductPresentation([element("alert", "The other participant is not ready yet. Wait, then explicitly retry this action.")])).toEqual({ phase: "unknown", reason: "not-ready" });
    expect(readVoiceProductPresentation([element("alert", "Voice is busy. Wait a moment before retrying.")])).toEqual({ phase: "unknown", reason: "budget-exhausted" });
  });
  it("drops unknown text and refuses ambiguous public states or reasons", () => {
    const privateText = "private-id-token-or-exception";
    expect(readVoiceProductPresentation([])).toEqual({ phase: "unknown", reason: "none" });
    const result = readVoiceProductPresentation([element("status", privateText), element("alert", `Voice: ${privateText}. Review the call status before retrying.`)]);
    expect(result).toEqual({ phase: "unknown", reason: "other" });
    expect(JSON.stringify(result)).not.toContain(privateText);
    expect(readVoiceProductPresentation([element("status", phases[0][0]), element("status", phases[2][0]), element("alert", "Voice: context-expired. Review the call status before retrying."), element("alert", privateText)])).toEqual({ phase: "unknown", reason: "other" });
    expect(readVoiceProductPresentation([element("alert", ""), element("status", "Agreeing the full audience… suffix")])).toEqual({ phase: "unknown", reason: "none" });
  });
});


describe("bounded Voice console diagnostics", () => {
  it("keeps only status and a fixed endpoint category, including during permission revocation", () => {
    const result = classifyVoiceProductConsole("Failed to load resource: the server responded with a status of 403 (Forbidden)", "https://example.test/api/voice/control?token=private", "https://example.test/app/private");
    expect(result).toEqual({ kind: "http-resource", status: 403, endpoint: "voice-control", code: "other" });
    expect(JSON.stringify(result)).not.toMatch(/private|token|example/);
  });
  it("does not turn unknown messages or foreign/missing locations into allowed errors", () => {
    expect(classifyVoiceProductConsole("private native error", "", "https://example.test/app")).toEqual({ kind: "other", status: null, endpoint: "other", code: "other" });
    expect(classifyVoiceProductConsole("Failed to load resource: the server responded with a status of 409 (Conflict)", "https://foreign.test/api/voice/control", "https://example.test/app")).toEqual({ kind: "http-resource", status: 409, endpoint: "other", code: "other" });
    expect(classifyVoiceProductConsole("private error", "https://example.test/_next/static/chunks/private.js", "https://example.test/app")).toEqual({ kind: "other", status: null, endpoint: "app-script", code: "other" });
  });
  it("attributes errors raised inside Cloudflare's Turnstile frame to it, never to the product", () => {
    // WebKit logs a revoked blob inside the sign-up challenge frame.
    expect(classifyVoiceProductConsole("Failed to load resource: The operation couldn’t be completed. (WebKitBlobResource error 1.)", "blob:https://challenges.cloudflare.com/38dfc988-f837-4c2a-8375-a5fb6d17dcc2", "https://example.test/sign-up")).toEqual({ kind: "other", status: null, endpoint: "turnstile", code: "other" });
    expect(classifyVoiceProductConsole("private error", "https://challenges.cloudflare.com.evil.test/x.js", "https://example.test/sign-up").endpoint).toBe("other");
  });
});


it.each([
  ["DataChannel error on reliable: private detail", "data-channel-error"],
  ["Unknown DataChannel error on lossy private detail", "data-channel-unknown"],
  ["Tried to add a track for a participant, that's not present. Sid: private", "missing-track"],
  ["NotFoundError: Failed to execute 'removeChild' on 'Node': private", "dom-removal"],
  ["Error: Minified React error #418; private", "react"],
  ["AbortError: The play() request was interrupted private", "playback-interrupted"],
  ["Native encryption worker failed private", "worker"],
  ["WebSocket is already in CLOSING or CLOSED state.", "closed-transport"],
  ["error reading from signal stream private detail", "signal-read"],
  ["unable to subscribe because MediaStreamTrack is ended. Do not call MediaStreamTrack.stop() private detail", "ended-track-subscription"],
  ["unable to set answer private detail", "session-description"],
  ["missing track resolver for private", "missing-track-resolver"],
  ["unsupported data type private detail", "unsupported-data"],
  ["Received encrypted packet but E2EE not set up", "missing-e2ee"],
  ["publisher data channel 'DATA_TRACK_LOSSY' closed unexpectedly", "data-channel-closed"],
])("classifies a public failure prefix without retaining its detail", (text, code) => {
  const result = classifyVoiceProductConsole(text, "", "https://example.test/app");
  expect(result.code).toBe(code);
  expect(JSON.stringify(result)).not.toContain("private");
});


it("retains only public RTC cause enums and bounded numeric codes from console arguments", () => {
  const result = readVoiceProductConsoleArgument({ error: { name: "OperationError", errorDetail: "sctp-failure", sctpCauseCode: 12, message: "private", token: "private" }, identity: "private" });
  expect(result).toEqual({ name: "OperationError", detail: "sctp-failure", cause: 12 });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(readVoiceProductConsoleArgument({ errorDetail: "private", sctpCauseCode: Infinity, name: "private" })).toEqual({ name: "other", detail: "other", cause: null });
  expect(readVoiceProductConsoleArgument("private")).toEqual({ name: "none", detail: "none", cause: null });
});

it("fingerprints unknown console text by leading words with identifiers masked", () => {
  expect(fingerprintVoiceProductConsole("could not do thing for PA_x9Yz room wss://h.test/rtc?access_token=eyJ.a.b trailing words")).toBe("could not do thing for #");
  expect(fingerprintVoiceProductConsole("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig v=0 o=- 4611731400430051336")).toBe("token # # # #");
});
