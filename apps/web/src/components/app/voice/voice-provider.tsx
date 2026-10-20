"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { authClient } from "@/lib/auth-client";
import { CallSession, VoiceCallSessionError, type VoiceCallView } from "@/lib/voice/call-session";
import { VOICE_LIMITS } from "@/lib/voice/contracts";
import type { VoiceSource } from "@/lib/voice/media-session";
import { voiceFrameTransform } from "@/lib/voice/support";
import { prepareCurrentVoiceAudience } from "./voice-audience";
import { automaticVoiceVerificationSteps } from "./voice-verification";

/** A community voice channel, or with `dm` a direct-message conversation (same encrypted call, different authorization). */
type Channel = { id: string; name: string; href: string; dm?: boolean };
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
const interrupted = "the connection to the voice server was interrupted. Calls never resume with old keys, so rejoin to start a fresh encrypted call.";
const endReasons: Record<string, string> = {
  "media-reconnecting": interrupted, "media-signal-reconnecting": interrupted, "media-disconnected": interrupted, network: interrupted, timeout: interrupted,
  "media-connect-failed": "couldn't connect to the voice server. Check your network, VPN or firewall (Voice needs WebRTC/TURN access), then rejoin.",
  "media-keying-expired": "setting up encrypted media took too long. Rejoin to try again.",
  "media-encryption-failed": "media encryption failed, so the call was stopped. Rejoin to try again.",
  "media-permission-reduced": "you no longer have permission to use this call.", forbidden: "you no longer have permission to use this call.",
  unauthorized: "you were signed out. Sign in again, then rejoin.", "session-changed": "you were signed out or your session changed.",
  "lease-expired": "the call connection expired. Rejoin to continue.",
  internal: "the voice server had a problem. Rejoin to try again.",
  rate_limited: "too many requests. Wait a moment, then rejoin.", "budget-exhausted": "too many requests. Wait a moment, then rejoin.",
};
function voiceEndedText(code: string): string {
  // StrictVoiceWorker reports sentences, not codes; every one of them is an encryption stop.
  const reason = endReasons[code] ?? (/^[a-z_-]+$/.test(code) ? undefined : endReasons["media-encryption-failed"]);
  return reason ? `Voice stopped: ${reason}` : `Voice stopped (${code}). Rejoin when ready.`;
}
export function voiceStatus(view: VoiceCallView | null, joining: boolean): string {
  if (joining) return "Connecting: creating a temporary Voice device…";
  if (!view) return "Join to review the current audience.";
  if (view.state === "ended") return view.error ? voiceEndedText(view.error) : "Voice stopped. Join again to start a fresh call.";
  if (view.reconnecting) return "Reconnecting to the voice server… The call ends safely if the connection does not return.";
  if (view.media.mediaState === "ready") return view.media.microphone ? "Encrypted voice ready — microphone on" : "Encrypted voice ready — microphone off";
  if (view.media.mediaState === "keying" || view.state === "agreed") return "Preparing encrypted media…";
  if (view.state === "retry-required") return "Audience attempt expired. Review everyone and retry.";
  if (view.state === "negotiating") return "Agreeing the full audience…";
  if (view.state === "waiting" && view.localConsentPending) return "Waiting for your full audience consent.";
  if (view.state === "waiting") return "Waiting for participant setup and audience consent.";
  if (view.roster.length <= 1) return "Waiting for others to join…";
  return "Compare symbols with each participant, then admit them.";
}
const VOICE_UNSUPPORTED_BROWSER = "This browser does not support encrypted Voice. Use a current version of Chrome or Firefox.";
const deviceLabels: Record<VoiceSource, string> = { microphone: "microphone", camera: "camera", screen_share: "screen" };
export function voiceErrorText(error: unknown, source?: VoiceSource): string {
  if (error instanceof VoiceCallSessionError) {
    if (error.code === "unsupported-media") return VOICE_UNSUPPORTED_BROWSER;
    if (error.code === "messaging-setup-required") return "Set up encrypted messaging in Devices and recovery first, then return and join Voice.";
    if (error.code === "not-ready") return "The other participant is not ready yet. Wait, then explicitly retry this action.";
    if (error.code === "budget-exhausted") return "Voice is busy. Wait a moment before retrying.";
    if (error.code === "server-unreachable") return "Couldn't reach the voice server. Check your connection, then rejoin.";
    if (error.code === "previous-call-closing") return "Your previous call is still closing on the server. Wait a few seconds, then rejoin.";
    if (error.code === "rate-limited") return "Too many requests. Wait a moment, then rejoin.";
    if (error.code === "call-full") return `This call is full (${VOICE_LIMITS.members} devices). Leave on another device to join.`;
    return `Voice stopped (${error.code}). Join again when ready.`;
  }
  // Permission errors and browser picker cancellation must never claim capture succeeded.
  const name = error instanceof Error ? error.name : "";
  const label = source ? deviceLabels[source] : "microphone or camera", Label = label[0].toUpperCase() + label.slice(1);
  if (source === "screen_share" && (name === "NotAllowedError" || name === "AbortError")) return "Screen sharing was cancelled or blocked. Try again and pick a screen or window.";
  if (name === "NotAllowedError") return `${Label} access was blocked. Allow it in your browser's site settings (next to the address bar), then try again.`;
  if (name === "NotFoundError" || name === "OverconstrainedError") return `No ${label} was found. Connect one, then try again.`;
  if (name === "NotReadableError" || name === "AbortError") return `Your ${label} is in use by another app or couldn't start. Close other apps using it, then try again.`;
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
  const autoSteps = useRef(new Set<string>());
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
    setSession(null); setChannel(null); setJoining(false); setBusy(false); setPendingSources([]); sourceFlights.current.clear(); autoSteps.current.clear();
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
      if (!voiceFrameTransform()) throw new VoiceCallSessionError("unsupported-media");
      const created = await CallSession.create({ accountId, sessionId, ...(target.dm ? { conversationId: target.id } : { channelId: target.id }), consent: true, assertSessionCurrent });
      try { assertSessionCurrent(); } catch (error) { void created.close("join-superseded").catch(() => {}); throw error; }
      current.current = created; setSession(created);
    } catch (error) { if (mine === revision.current && mounted.current) setError(voiceErrorText(error)); }
    finally { if (mine === revision.current && mounted.current) setJoining(false); }
  }, [accountId, sessionId, leave]);
  const run = useCallback(async (operation: (call: CallSession) => Promise<void>) => {
    const call = current.current, mine = revision.current;
    if (!call) return;
    setBusy(true); setError(null);
    try { await operation(call); } catch (error) { if (mine === revision.current && mounted.current) setError(voiceErrorText(error)); }
    finally { if (mine === revision.current && mounted.current) setBusy(false); }
  }, []);
  // Protocol-only SAS steps (no trust decision) run once each; symbol confirmation and admission stay manual.
  useEffect(() => {
    if (!view || busy || !authenticated) return;
    const next = automaticVoiceVerificationSteps(view).find(step => !autoSteps.current.has(step.key));
    if (!next) return;
    autoSteps.current.add(next.key);
    void run(call => next.step === "request" ? call.requestVerification(next.memberId) : call.verificationStep(next.handle, next.step));
  }, [view, busy, authenticated, run]);
  const toggleSource = async (source: VoiceSource) => {
    const call = current.current, mine = revision.current;
    if (!call || sourceFlights.current.has(source)) return;
    sourceFlights.current.add(source); setPendingSources([...sourceFlights.current]); setError(null);
    const media = call.getSnapshot().media;
    try {
      if (source === "microphone") await call.setMicrophoneEnabled(!media.microphone);
      else if (source === "camera") await call.setCameraEnabled(!media.camera);
      else await call.setScreenShareEnabled(!media.screenShare);
    } catch (error) { if (mine === revision.current && mounted.current) setError(voiceErrorText(error, source)); }
    finally { if (mine === revision.current && mounted.current) { sourceFlights.current.delete(source); setPendingSources([...sourceFlights.current]); } }
  };
  const mountVideo = useCallback((id: string, element: HTMLVideoElement) => {
    try { return current.current?.mountVideo(id, element) ?? (() => {}); }
    catch { return () => {}; } // A synchronous fence can invalidate a rendered tile before its effect runs.
  }, []);
  return <VoiceContext.Provider value={{ channel, view, joining: joining && authenticated, busy: busy && authenticated, pendingSources, authenticated, error: error ?? (view?.error && view.state !== "ended" ? `Voice: ${view.error}. Review the call status before retrying.` : null), join, leave, requestVerification: id => run(call => call.requestVerification(id)), verificationStep: (handle, step) => run(call => call.verificationStep(handle, step)), admit: id => run(call => call.admit(id)), confirmFullRoster: () => run(prepareCurrentVoiceAudience), toggleSource, mountVideo, startAudio: () => run(call => call.startAudio()) }}>
    {children}<div ref={audio} hidden aria-hidden="true" />
  </VoiceContext.Provider>;
}
