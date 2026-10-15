"use client";

import type { Room } from "livekit-client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { joinVoice } from "@/app/app/actions";

export interface VoicePeer {
  id: string;
  name: string;
  speaking: boolean;
  muted: boolean;
  isLocal: boolean;
}

export type VoiceStatus = "idle" | "connecting" | "connected";

interface VoiceValue {
  status: VoiceStatus;
  /** The voice channel we're connected (or connecting) to. */
  channel: { id: string; name: string; href: string } | null;
  peers: VoicePeer[];
  muted: boolean;
  canSpeak: boolean;
  error: string | null;
  join: (channel: { id: string; name: string; href: string }) => Promise<void>;
  leave: () => void;
  toggleMute: () => Promise<void>;
}

const VoiceContext = createContext<VoiceValue | null>(null);

export function useVoice(): VoiceValue {
  const value = useContext(VoiceContext);
  if (!value) throw new Error("useVoice must be used inside <VoiceProvider>");
  return value;
}

function peersOf(room: Room): VoicePeer[] {
  const local = room.localParticipant;
  const all = [local, ...room.remoteParticipants.values()];
  return all.map((p) => ({
    id: p.identity,
    name: p.name || "Member",
    speaking: p.isSpeaking,
    muted: !p.isMicrophoneEnabled,
    isLocal: p === local,
  }));
}

/** App-wide, so a voice call survives navigating to text channels (like a phone call in the background). */
export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const room = useRef<Room | null>(null);
  const audio = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [channel, setChannel] = useState<VoiceValue["channel"]>(null);
  const [peers, setPeers] = useState<VoicePeer[]>([]);
  const [muted, setMuted] = useState(true);
  const [canSpeak, setCanSpeak] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const leave = useCallback(() => {
    const current = room.current;
    room.current = null;
    void current?.disconnect();
    setStatus("idle");
    setChannel(null);
    setPeers([]);
    if (audio.current) audio.current.replaceChildren();
  }, []);

  const join = useCallback(
    async (target: { id: string; name: string; href: string }) => {
      leave();
      setError(null);
      setStatus("connecting");
      setChannel(target);
      const result = await joinVoice(target.id);
      if (!result.ok) {
        setError(result.error);
        setStatus("idle");
        setChannel(null);
        return;
      }
      // Loaded on demand: the WebRTC client is large and most visits never join voice.
      const { Room, RoomEvent, Track } = await import("livekit-client");
      const next = new Room({ adaptiveStream: true, dynacast: true });
      room.current = next;
      const refresh = () => room.current === next && setPeers(peersOf(next));
      next
        .on(RoomEvent.ParticipantConnected, refresh)
        .on(RoomEvent.ParticipantDisconnected, refresh)
        .on(RoomEvent.ActiveSpeakersChanged, refresh)
        .on(RoomEvent.TrackMuted, refresh)
        .on(RoomEvent.TrackUnmuted, refresh)
        .on(RoomEvent.LocalTrackPublished, refresh)
        .on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio) audio.current?.appendChild(track.attach());
          refresh();
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => {
          track.detach().forEach((el) => el.remove());
          refresh();
        })
        .on(RoomEvent.Disconnected, () => {
          if (room.current !== next) return;
          // Removed by the server (kicked, banned, lost access) or the network gave up.
          setError("You were disconnected from voice.");
          leave();
        });
      try {
        await next.connect(result.data.url, result.data.token);
      } catch {
        if (room.current === next) {
          setError("Couldn't connect to voice. Check your connection and try again.");
          leave();
        }
        return;
      }
      setCanSpeak(result.data.canSpeak);
      setStatus("connected");
      if (result.data.canSpeak) {
        try {
          await next.localParticipant.setMicrophoneEnabled(true);
          setMuted(false);
        } catch {
          setMuted(true);
          setError("Microphone access was blocked. You can listen; allow the microphone to speak.");
        }
      } else setMuted(true);
      refresh();
    },
    [leave],
  );

  const toggleMute = useCallback(async () => {
    const current = room.current;
    if (!current || !canSpeak) return;
    const next = !muted;
    try {
      await current.localParticipant.setMicrophoneEnabled(!next);
      setMuted(next);
      setError(null);
    } catch {
      setError("Microphone access was blocked. Allow it in your browser to speak.");
    }
    setPeers(peersOf(current));
  }, [canSpeak, muted]);

  useEffect(() => () => void room.current?.disconnect(), []);

  const value = useMemo(
    () => ({ status, channel, peers, muted, canSpeak, error, join, leave, toggleMute }),
    [status, channel, peers, muted, canSpeak, error, join, leave, toggleMute],
  );
  return (
    <VoiceContext.Provider value={value}>
      {children}
      {/* Remote audio plays from here, outside any page, so navigation doesn't cut it off. */}
      <div ref={audio} hidden />
    </VoiceContext.Provider>
  );
}
