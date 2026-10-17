"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { authClient } from "@/lib/auth-client";
import { CallSession, VoiceCallSessionError, type VoiceCallView } from "@/lib/voice/call-session";
import type { VoiceSource } from "@/lib/voice/media-session";
import { prepareCurrentVoiceAudience } from "./voice-audience";

type Channel = { id: string; name: string; href: string };
type VerificationStep = Parameters<CallSession["verificationStep"]>[1];
interface VoiceValue {
  channel: Channel | null;
  view: VoiceCallView | null;
  joining: boolean;
  busy: boolean;
  pendingSources: readonly VoiceSource[];
  authenticated: boolean;
  error: string | null;
  join(channel: Channel): Promise<void>;
  leave(): void;
  requestVerification(memberId: string): Promise<void>;
  verificationStep(handle: string, step: VerificationStep): Promise<void>;
  admit(memberId: string): Promise<void>;
  confirmFullRoster(): Promise<void>;
  toggleSource(source: VoiceSource): Promise<void>;
  mountVideo(id: string, element: HTMLVideoElement): () => void;
  startAudio(): Promise<void>;
}
const VoiceContext = createContext<VoiceValue | null>(null);
export function useVoice(): VoiceValue {
  const value = useContext(VoiceContext);
  if (!value) throw new Error("useVoice must be used inside <VoiceProvider>");
  return value;
}
const noopSubscribe = () => () => {};
const emptySnapshot = () => null;
export function voiceStatus(view: VoiceCallView | null, joining: boolean): string {
  if (joining) return "Creating temporary Voice device…";
  if (!view) return "Join to review the current audience.";
  if (view.state === "ended") return "Voice stopped. Join again to start a fresh call.";
  if (view.media.mediaState === "ready") return view.media.microphone ? "Encrypted voice ready — microphone on" : "Encrypted voice ready — microphone off";
  if (view.media.mediaState === "keying" || view.state === "agreed") return "Preparing encrypted media…";
  if (view.state === "retry-required") return "Audience attempt expired. Review everyone and retry.";
  if (view.state === "negotiating") return "Agreeing the full audience…";
  if (view.state === "waiting" && view.localConsentPending) return "Waiting for your full audience consent.";
  if (view.state === "waiting") return "Waiting for participant setup and audience consent.";
  return "Verify every participant, then admit them separately.";
}
function errorText(error: unknown): string {
  if (error instanceof VoiceCallSessionError) {
    if (error.code === "messaging-setup-required") return "Set up encrypted messaging in Devices and recovery first, then return and join Voice.";
    if (error.code === "not-ready") return "The other participant is not ready yet. Wait, then explicitly retry this action.";
    if (error.code === "budget-exhausted") return "Voice is busy. Wait a moment before retrying.";
    return `Voice stopped (${error.code}). Join again when ready.`;
  }
  // Permission errors and browser picker cancellation must never claim capture succeeded.
  if (error instanceof DOMException && ["NotAllowedError", "NotFoundError", "NotReadableError", "AbortError"].includes(error.name)) return "Capture did not start. Check device permissions or retry the screen picker.";
  return "Voice could not complete this action. Check the call status and retry.";
}

/** Passive presentation can lag behind a synchronous authority fence. */
export function mountCurrentVoiceAudio(
  session: { getSnapshot(): Pick<VoiceCallView, "state">; mountAudio(container: HTMLElement): () => void },
  isCurrent: () => boolean,
  container: HTMLElement,
): (() => void) | undefined {
  if (!isCurrent() || session.getSnapshot().state === "ended") return;
  try { return session.mountAudio(container); }
  catch (error) {
    if (!isCurrent() || error instanceof VoiceCallSessionError && ["ended", "lease-expired", "binding-changed"].includes(error.code)) return;
    throw error;
  }
}

/** One authenticated app lifetime; navigation only mounts and detaches presentation. */
export function VoiceProvider({ accountId, sessionId, children }: { accountId: string; sessionId: string; children: React.ReactNode }) {
  const auth = authClient.useSession();
  const authenticated = !auth.isPending && !auth.error && auth.data?.user.id === accountId && auth.data.session.id === sessionId;
  const identityCurrent = useRef(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const current = useRef<CallSession | null>(null);
  const audio = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<CallSession | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [joining, setJoining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingSources, setPendingSources] = useState<VoiceSource[]>([]);
  const sourceFlights = useRef(new Set<VoiceSource>());
  const [error, setError] = useState<string | null>(null);
  const view = useSyncExternalStore(session?.subscribe ?? noopSubscribe, session?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const fence = useCallback((reason = "left") => {
    revision.current++;
    const old = current.current; current.current = null;
    // close fences synchronously; its external snapshot reports ended before retirement finishes.
    void old?.close(reason).catch(() => {});
  }, []);
  const leave = useCallback(() => {
    fence();
    setSession(null); setChannel(null); setJoining(false); setBusy(false); setPendingSources([]); sourceFlights.current.clear();
  }, [fence]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; identityCurrent.current = false; fence("provider-unmounted"); };
  }, [fence]);
  useEffect(() => {
    identityCurrent.current = authenticated;
    // Authority changes fence the external CallSession store synchronously, without mirroring it into React state.
    if (!authenticated && !auth.isPending) fence("session-changed");
  }, [authenticated, auth.isPending, fence]);
  useEffect(() => {
    if (session && audio.current) return mountCurrentVoiceAudio(session, () => mounted.current && identityCurrent.current && current.current === session, audio.current);
  }, [session]);
  const join = useCallback(async (target: Channel) => {
    leave(); const mine = revision.current;
    const assertSessionCurrent = () => { if (!mounted.current || !identityCurrent.current || mine !== revision.current) throw new VoiceCallSessionError("ended"); };
    setError(null); setChannel(target); setJoining(true);
    try {
      assertSessionCurrent();
      if (typeof RTCRtpSender === "undefined" || typeof RTCRtpReceiver === "undefined" || !("createEncodedStreams" in RTCRtpSender.prototype) || !("createEncodedStreams" in RTCRtpReceiver.prototype)) throw new VoiceCallSessionError("unsupported-media");
      const created = await CallSession.create({ accountId, sessionId, channelId: target.id, consent: true, assertSessionCurrent });
      try { assertSessionCurrent(); } catch (error) { void created.close("join-superseded").catch(() => {}); throw error; }
      current.current = created; setSession(created);
    } catch (error) { if (mine === revision.current && mounted.current) setError(error instanceof VoiceCallSessionError && error.code === "unsupported-media" ? "This browser does not support the encoded-stream encryption Voice requires. Use a supported Chromium browser." : errorText(error)); }
    finally { if (mine === revision.current && mounted.current) setJoining(false); }
  }, [accountId, sessionId, leave]);
  const run = useCallback(async (operation: (call: CallSession) => Promise<void>) => {
    const call = current.current, mine = revision.current;
    if (!call) return;
    setBusy(true); setError(null);
    try { await operation(call); } catch (error) { if (mine === revision.current && mounted.current) setError(errorText(error)); }
    finally { if (mine === revision.current && mounted.current) setBusy(false); }
  }, []);
  const toggleSource = async (source: VoiceSource) => {
    const call = current.current, mine = revision.current;
    if (!call || sourceFlights.current.has(source)) return;
    sourceFlights.current.add(source); setPendingSources([...sourceFlights.current]); setError(null);
    const media = call.getSnapshot().media;
    try {
      if (source === "microphone") await call.setMicrophoneEnabled(!media.microphone);
      else if (source === "camera") await call.setCameraEnabled(!media.camera);
      else await call.setScreenShareEnabled(!media.screenShare);
    } catch (error) { if (mine === revision.current && mounted.current) setError(errorText(error)); }
    finally { if (mine === revision.current && mounted.current) { sourceFlights.current.delete(source); setPendingSources([...sourceFlights.current]); } }
  };
  const mountVideo = useCallback((id: string, element: HTMLVideoElement) => {
    try { return current.current?.mountVideo(id, element) ?? (() => {}); }
    catch { return () => {}; } // A synchronous fence can invalidate a rendered tile before its effect runs.
  }, []);
  return <VoiceContext.Provider value={{ channel, view, joining: joining && authenticated, busy: busy && authenticated, pendingSources, authenticated, error: error ?? (view?.error ? `Voice: ${view.error}. Review the call status before retrying.` : null), join, leave, requestVerification: id => run(call => call.requestVerification(id)), verificationStep: (handle, step) => run(call => call.verificationStep(handle, step)), admit: id => run(call => call.admit(id)), confirmFullRoster: () => run(prepareCurrentVoiceAudience), toggleSource, mountVideo, startAudio: () => run(call => call.startAudio()) }}>
    {children}<div ref={audio} hidden aria-hidden="true" />
  </VoiceContext.Provider>;
}
