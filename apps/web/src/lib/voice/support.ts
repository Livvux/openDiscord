export type VoiceFrameTransform = "encoded-streams" | "script-transform";
type Scope = { RTCRtpSender?: unknown; RTCRtpReceiver?: unknown; RTCRtpScriptTransform?: unknown };

const encodedStreams = (api: unknown) => typeof api === "function" && "createEncodedStreams" in api.prototype;

/**
 * The two frame-transform APIs livekit-client's E2EE worker can run in: Chromium's
 * legacy encoded streams, or standard RTCRtpScriptTransform (Firefox, Safari). Media
 * never falls back to plaintext; without either, Voice refuses to start.
 * Kept free of livekit-client so the provider can check before any dynamic import.
 */
export function voiceFrameTransform(scope: Scope = globalThis as Scope): VoiceFrameTransform | null {
  if (encodedStreams(scope.RTCRtpSender) && encodedStreams(scope.RTCRtpReceiver)) return "encoded-streams";
  return typeof scope.RTCRtpScriptTransform === "function" ? "script-transform" : null;
}
