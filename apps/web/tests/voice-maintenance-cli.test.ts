import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sweep: vi.fn(), end: vi.fn() }));
vi.mock("../src/db", () => ({ db: { $client: { end: mocks.end } } }));
vi.mock("../src/server/voice-control", () => ({ sweepVoiceLifecycle: mocks.sweep }));
const argv = process.argv;
const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  mocks.end.mockReset().mockResolvedValue(undefined);
  mocks.sweep.mockReset().mockResolvedValue({ scanned: 1, closed: 1, removed: 0, closedCallIds: ["private-call"], limited: false,
    rooms: { claimed: 0, requests: 0, retired: 0, deleted: 0, failed: 0, unavailable: 0, limited: false } });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => { process.argv = argv; process.exitCode = originalExitCode; vi.restoreAllMocks(); });

it("defaults to dry run, invokes one bounded batch, closes the pool and omits identifiers", async () => {
  process.argv = ["node", "voice-maintenance.ts"];
  await import("../scripts/voice-maintenance");
  await vi.waitFor(() => expect(mocks.end).toHaveBeenCalledOnce());
  expect(mocks.sweep).toHaveBeenCalledWith({ apply: false, now: expect.any(Date), batchSize: 8, maxBatches: 1 });
  expect(console.log).toHaveBeenCalledOnce();
  expect(String(vi.mocked(console.log).mock.calls[0][0])).not.toContain("private-call");
});

it("rejects unknown arguments without invoking the sweep and closes the pool", async () => {
  process.argv = ["node", "voice-maintenance.ts", "--all"];
  await import("../scripts/voice-maintenance");
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(mocks.sweep).not.toHaveBeenCalled();
  expect(mocks.end).toHaveBeenCalledOnce();
});

it("closes the pool on SQL failure and sanitizes errors", async () => {
  process.argv = ["node", "voice-maintenance.ts", "--apply"];
  mocks.sweep.mockRejectedValue(new Error("private database connection"));
  await import("../scripts/voice-maintenance");
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(mocks.end).toHaveBeenCalledOnce();
  expect(String(vi.mocked(console.error).mock.calls)).not.toContain("private database connection");
});

it.each(["failed", "unavailable"])("reports an actual SDK %s as a job failure", async key => {
  process.argv = ["node", "voice-maintenance.ts", "--apply"];
  const result = await mocks.sweep();
  result.rooms[key] = 1;
  mocks.sweep.mockClear().mockResolvedValue(result);
  await import("../scripts/voice-maintenance");
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(mocks.end).toHaveBeenCalledOnce();
});
