export type VoiceFrameTransform = "encoded-streams" | "script-transform";
type Scope = { RTCRtpSender?: unknown; RTCRtpReceiver?: unknown; RTCRtpScriptTransform?: unknown; userAgent?: string };

const encodedStreams = (api: unknown) => typeof api === "function" && "createEncodedStreams" in api.prototype;
// Mirrors livekit-client 2.22.4 isChromiumBased(): its "Chrome" (incl. Edge, not iOS) always takes the encoded-streams branch.
const chromium = (ua: string) => !/firefox|iceweasel|fxios/i.test(ua) && /chrom|crios|crmo/i.test(ua) && !/crios/i.test(ua);

// Explicit reads: WebRTC constructors are non-enumerable globals, so spreading globalThis would drop them.
function browserScope(): Scope {
  const g = globalThis as Scope;
  return { RTCRtpSender: g.RTCRtpSender, RTCRtpReceiver: g.RTCRtpReceiver, RTCRtpScriptTransform: g.RTCRtpScriptTransform, userAgent: globalThis.navigator?.userAgent };
}

/**
 * The two frame-transform APIs livekit-client's E2EE worker can run in: Chromium's
 * legacy encoded streams, or standard RTCRtpScriptTransform (Firefox, Safari). Media
 * never falls back to plaintext; without either, Voice refuses to start.
 * Kept free of livekit-client so the provider can check before any dynamic import.
 */
export function voiceFrameTransform(scope: Scope = browserScope()): VoiceFrameTransform | null {
  if (encodedStreams(scope.RTCRtpSender) && encodedStreams(scope.RTCRtpReceiver)) return "encoded-streams";
  // Accept only the API the SDK will actually pick, so no sender is left without a transform.
  if (chromium(scope.userAgent ?? "")) return null;
  return typeof scope.RTCRtpScriptTransform === "function" ? "script-transform" : null;
}
