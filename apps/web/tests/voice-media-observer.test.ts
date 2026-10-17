import { describe, expect, it, vi } from "vitest";
import { assertDisposableVoiceCi, assertVoiceBrowserOrigin, createVoiceGrantObserver, legitimateStartupConflict } from "../e2e/fixtures/voice-media-observer";

const origin = "http://localhost:3200", path = "/api/voice/control";
const input = () => ({ method: "POST", body: JSON.stringify({ action: "token" }), signal: new AbortController().signal });
const body = () => ({ token: "disposable-unit-verifier-input", sources: [], participantIdentity: "unit-listener", roomName: "unit-room" });
const claims = () => ({ sources: [], publish: false, subscribe: true, data: false, expiresAtMs: Date.now() + 20_000 });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("test-only transparent fetch observer effects (no actual JWT/native/media acceptance)", () => {
  it("calls original once with identical args/signal and returns the same consumable Response without awaiting verifier", async () => {
    const response = Response.json(body()), request = input(), pending = gate<ReturnType<typeof claims>>();
    const nativeFetch = vi.fn<typeof fetch>(async () => response), verify = vi.fn(() => pending.promise);
    const observer = createVoiceGrantObserver(nativeFetch, origin, verify);
    const returned = await observer.fetch(path, request);
    expect(returned).toBe(response); expect(nativeFetch).toHaveBeenCalledExactlyOnceWith(path, request);
    expect(nativeFetch.mock.calls[0][1]?.signal).toBe(request.signal);
    expect(await returned.json()).toEqual(body());
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    expect(observer.snapshot()[0]).toMatchObject({ settled: false, bodyRead: true, signatureVerified: false, errorStage: "verify" });
    pending.resolve(claims()); await observer.settle();
    expect(observer.snapshot()[0]).toMatchObject({ settled: true, errorStage: "none", signatureVerified: true });
  });
  it("preserves the exact native fetch rejection while retaining a fixed hard-failure observation", async () => {
    const failure = new Error("raw transport detail must not enter ledger"), verify = vi.fn();
    const nativeFetch = vi.fn<typeof fetch>(async () => { throw failure; });
    const observer = createVoiceGrantObserver(nativeFetch, origin, verify);
    await expect(observer.fetch(path, input())).rejects.toBe(failure);
    expect(nativeFetch).toHaveBeenCalledOnce(); expect(verify).not.toHaveBeenCalled();
    expect(observer.snapshot()).toEqual([{ ordinal: 1, status: 0, settled: true, bodyRead: false, signatureVerified: false, errorStage: "fetch" }]);
  });
  it.each(["clone", "body"] as const)("handles detached %s failure immediately without changing the original Response", async stage => {
    const response = stage === "body" ? new Response("invalid JSON") : Response.json(body()), verify = vi.fn();
    if (stage === "clone") vi.spyOn(response, "clone").mockImplementation(() => { throw new Error("raw clone detail"); });
    const observer = createVoiceGrantObserver(vi.fn<typeof fetch>(async () => response), origin, verify);
    expect(await observer.fetch(path, input())).toBe(response);
    await observer.settle();
    expect(observer.snapshot()[0]).toMatchObject({ settled: true, bodyRead: false, signatureVerified: false, errorStage: stage });
    expect(verify).not.toHaveBeenCalled(); expect(await response.text()).toBe(stage === "body" ? "invalid JSON" : JSON.stringify(body()));
  });
  it("never turns rejected/late verification into success or exports JWT, identity, room or raw exceptions", async () => {
    const verify = vi.fn(async () => { throw new Error("private verifier exception"); });
    const observer = createVoiceGrantObserver(vi.fn<typeof fetch>(async () => Response.json(body())), origin, verify);
    await observer.fetch(path, input()); await observer.settle();
    expect(verify).toHaveBeenCalledExactlyOnceWith(body().token, { identity: "unit-listener", room: "unit-room", sources: [] });
    expect(observer.snapshot()).toEqual([{ ordinal: 1, status: 200, settled: true, bodyRead: true, signatureVerified: false, errorStage: "verify" }]);
    const pending = gate<ReturnType<typeof claims>>(), late = createVoiceGrantObserver(vi.fn<typeof fetch>(async () => Response.json(body())), origin, () => pending.promise, 5);
    await late.fetch(path, input()); await late.settle();
    expect(late.snapshot()[0]).toMatchObject({ settled: true, signatureVerified: false, errorStage: "timeout" });
    pending.resolve(claims()); await late.settle();
    expect(late.snapshot()[0]).toMatchObject({ signatureVerified: false, errorStage: "timeout" });
  });
  it("exports only copied verified capability/expiry fields for each real response clone", async () => {
    const verified = claims(), observer = createVoiceGrantObserver(vi.fn<typeof fetch>(async () => Response.json(body())), origin, async () => verified);
    await observer.fetch(path, input()); await observer.fetch(path, input()); await observer.settle();
    expect(observer.snapshot()).toEqual([1, 2].map(ordinal => ({ ordinal, status: 200, settled: true, bodyRead: true, signatureVerified: true, errorStage: "none", grant: verified })));
    const snapshot = observer.snapshot(); snapshot[0].grant!.sources.push("camera");
    expect(observer.snapshot()[0].grant!.sources).toEqual([]);
    expect(JSON.stringify(observer.snapshot())).not.toContain(body().token); expect(JSON.stringify(observer.snapshot())).not.toContain(body().participantIdentity); expect(JSON.stringify(observer.snapshot())).not.toContain(body().roomName);
  });
  it("admits only exact existing disposable CI credentials and loopback origins", () => {
    const fixture = { ci: "true", githubActions: "true", apiKey: "devkey", apiSecret: "secret", url: "ws://localhost:7880", authUrl: "http://localhost:3000" };
    expect(() => assertDisposableVoiceCi(fixture)).not.toThrow(); expect(() => assertVoiceBrowserOrigin(origin)).not.toThrow();
    for (const change of [{ ci: "false" }, { githubActions: "false" }, { apiKey: "operator" }, { apiSecret: "operator-secret" }, { url: "wss://operator.example" }, { authUrl: "https://operator.example" }]) expect(() => assertDisposableVoiceCi({ ...fixture, ...change })).toThrow("Exact disposable loopback CI fixture required");
    expect(() => assertVoiceBrowserOrigin("https://operator.example")).toThrow("Disposable loopback browser required");
  });
  it("allows only exact startup crypto409 plus proven newer generation", () => {
    const request = { method: "POST", path, action: "crypto", status: 409, startup: true, expectedGeneration: 1, currentGeneration: 3 };
    expect(legitimateStartupConflict(request)).toBe(true);
    for (const change of [{ method: "GET" }, { path: "/api/other" }, { action: "token" }, { status: 403 }, { startup: false }, { currentGeneration: 1 }, { expectedGeneration: 0 }]) expect(legitimateStartupConflict({ ...request, ...change })).toBe(false);
  });
});
