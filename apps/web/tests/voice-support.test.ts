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
  it("follows livekit-client's choice: Chromium (incl. Edge) never uses script transforms", () => {
    const chrome = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Safari/537.36";
    const edge = `${chrome} Edg/156.0`;
    // The SDK would call createEncodedStreams here; without it the sender would stay untransformed.
    expect(voiceFrameTransform({ RTCRtpSender: plain, RTCRtpReceiver: plain, RTCRtpScriptTransform: script, userAgent: chrome })).toBeNull();
    expect(voiceFrameTransform({ RTCRtpSender: plain, RTCRtpReceiver: plain, RTCRtpScriptTransform: script, userAgent: edge })).toBeNull();
    expect(voiceFrameTransform({ RTCRtpSender: encoded, RTCRtpReceiver: encoded, RTCRtpScriptTransform: script, userAgent: edge })).toBe("encoded-streams");
    expect(voiceFrameTransform({ RTCRtpSender: plain, RTCRtpReceiver: plain, RTCRtpScriptTransform: script, userAgent: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/156.0 Mobile/15E148 Safari/604.1" })).toBe("script-transform");
    expect(voiceFrameTransform({ RTCRtpSender: plain, RTCRtpReceiver: plain, RTCRtpScriptTransform: script, userAgent: "Mozilla/5.0 (Macintosh; rv:157.0) Gecko/20100101 Firefox/157.0" })).toBe("script-transform");
  });
  it("refuses browsers with neither API, or encoded streams on only one side", () => {
    expect(voiceFrameTransform({})).toBeNull();
    expect(voiceFrameTransform({ RTCRtpSender: plain, RTCRtpReceiver: plain })).toBeNull();
    expect(voiceFrameTransform({ RTCRtpSender: encoded, RTCRtpReceiver: plain })).toBeNull();
    expect(voiceFrameTransform({ RTCRtpScriptTransform: {} })).toBeNull();
  });
});
