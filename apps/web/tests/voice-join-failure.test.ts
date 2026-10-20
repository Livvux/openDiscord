import { describe, expect, it } from "vitest";
import { joinFailure, VoiceCallSessionError } from "@/lib/voice/call-session";
import { VoiceHttpError } from "@/lib/voice/http-client";

const code = (error: unknown) => (error instanceof VoiceCallSessionError ? error.code : error);

describe("join failures for the Voice UI", () => {
  it("maps HTTP failures to session codes the UI may show", () => {
    expect(code(joinFailure(new VoiceHttpError("call_full", 409)))).toBe("call-full");
    expect(code(joinFailure(new VoiceHttpError("network")))).toBe("server-unreachable");
    expect(code(joinFailure(new VoiceHttpError("timeout")))).toBe("server-unreachable");
    expect(code(joinFailure(new VoiceHttpError("protocol", 503)))).toBe("server-unreachable");
    expect(code(joinFailure(new VoiceHttpError("conflict", 409)))).toBe("previous-call-closing");
    expect(code(joinFailure(new VoiceHttpError("rate_limited", 429)))).toBe("rate-limited");
  });
  it("keeps every other failure unchanged", () => {
    const forbidden = new VoiceHttpError("forbidden", 403), other = new Error("x");
    expect(joinFailure(forbidden)).toBe(forbidden);
    expect(joinFailure(other)).toBe(other);
  });
});
