import { describe, expect, it, vi } from "vitest";
import { readVoiceRequestCandidates, voiceRequestCandidate } from "../e2e/fixtures/voice-product-candidates";

const button = (disabled = false, ariaDisabled = false) => ({ matches: () => disabled, getAttribute: () => ariaDisabled ? "true" : null });

describe("actual Voice request UI candidate selection", () => {
  it.each([0, 1])("selects side %i without waiting on the absent opposite candidate", async side => {
    const readFirst = vi.fn(async () => voiceRequestCandidate(side === 0 ? [button()] : []));
    const readSecond = vi.fn(async () => voiceRequestCandidate(side === 1 ? [button()] : []));
    const selection = await readVoiceRequestCandidates(readFirst, readSecond);
    expect(selection.side).toBe(side);
    expect(selection.candidates[side]).toEqual({ count: 1, enabled: true });
    expect(selection.candidates[1 - side]).toEqual({ count: 0, enabled: false });
    expect(readFirst).toHaveBeenCalledOnce(); expect(readSecond).toHaveBeenCalledOnce();
  });
  it.each([
    [[], []],
    [[button(true)], [button(true)]],
    [[button(false, true)], []],
    [[button()], [button()]],
    [[button(), button()], []],
    [[button(), button()], [button()]],
  ])("refuses absent, disabled or ambiguous candidates", async (first, second) => {
    const selection = await readVoiceRequestCandidates(async () => voiceRequestCandidate(first), async () => voiceRequestCandidate(second));
    expect(selection.side).toBeNull();
  });
  it("retains the sampled eligible side instead of choosing again from later visibility", async () => {
    let first = [button()], second: ReturnType<typeof button>[] = [];
    const selected = await readVoiceRequestCandidates(async () => voiceRequestCandidate(first), async () => voiceRequestCandidate(second));
    first = []; second = [button()];
    expect(selected.side).toBe(0);
    expect((await readVoiceRequestCandidates(async () => voiceRequestCandidate(first), async () => voiceRequestCandidate(second))).side).toBe(1);
  });
  it("starts both independent observations before either resolves", async () => {
    let release!: (value: ReturnType<typeof voiceRequestCandidate>) => void;
    const first = new Promise<ReturnType<typeof voiceRequestCandidate>>(resolve => { release = resolve; });
    const second = vi.fn(async () => voiceRequestCandidate([button()]));
    const pending = readVoiceRequestCandidates(() => first, second);
    expect(second).toHaveBeenCalledOnce();
    release(voiceRequestCandidate([]));
    expect((await pending).side).toBe(1);
  });
});
