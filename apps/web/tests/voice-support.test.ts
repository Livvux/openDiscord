import { describe, expect, it } from "vitest";
import { voiceFrameTransform } from "@/lib/voice/support";

const encoded = class { createEncodedStreams() {} };
const plain = class {};
const script = class {};

describe("Voice frame-transform gate (no plaintext fallback)", () => {
  it("prefers Chromium encoded streams when sender and receiver both expose them", () => {
    expect(voiceFrameTransform({ RTCRtpSender: encoded, RTCRtpReceiver: encoded })).toBe("encoded-streams");
    expect(voiceFrameTransform({ RTCRtpSender: encoded, RTCRtpReceiver: encoded, RTCRtpScriptTransform: script })).toBe("encoded-streams");
  });
  it("accepts the standard RTCRtpScriptTransform used by Firefox and Safari", () => {
    expect(voiceFrameTransform({ RTCRtpSender: plain, RTCRtpReceiver: plain, RTCRtpScriptTransform: script })).toBe("script-transform");
  });
  it("refuses browsers with neither API, or encoded streams on only one side", () => {
    expect(voiceFrameTransform({})).toBeNull();
    expect(voiceFrameTransform({ RTCRtpSender: plain, RTCRtpReceiver: plain })).toBeNull();
    expect(voiceFrameTransform({ RTCRtpSender: encoded, RTCRtpReceiver: plain })).toBeNull();
    expect(voiceFrameTransform({ RTCRtpScriptTransform: {} })).toBeNull();
  });
});
