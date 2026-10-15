import { describe, expect, it } from "vitest";
import * as control from "@/server/voice-control";
import * as tokens from "@/server/voice";

// Deliberate behavioral RED before implementing the unreachable product boundary.
describe("unreachable bound media boundary", () => {
  it("offers a separate locked grant rather than reusing heartbeat or the old token API", () => {
    expect(Reflect.get(control, "grantBoundVoiceMedia")).toBeTypeOf("function");
    expect(Reflect.get(tokens, "createBoundVoiceToken")).toBeTypeOf("function");
  });
});
