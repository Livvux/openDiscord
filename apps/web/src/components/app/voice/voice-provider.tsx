"use client";

import type { Room, Track as LiveKitTrack } from "livekit-client";
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

export interface VideoTile {
  key: string;
  name: string;
  isLocal: boolean;
  screen: boolean;
  track: LiveKitTrack;
}

interface VoiceValue {
  status: VoiceStatus;
  /** The voice channel we're connected (or connecting) to. */
  channel: { id: string; name: string; href: string } | null;
  peers: VoicePeer[];
  videos: VideoTile[];
  muted: boolean;
  canSpeak: boolean;
  canVideo: boolean;
  cameraOn: boolean;
  sharing: boolean;
  error: string | null;
  /** The browser blocked autoplay of remote audio; `startAudio` (from a click) unblocks it. */
  audioBlocked: boolean;
  startAudio: () => Promise<void>;
  join: (channel: { id: string; name: string; href: string }) => Promise<void>;
  leave: () => void;
  toggleMute: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
}

const VoiceContext = createContext<VoiceValue | null>(null);
/** `livekit.TrackSource` values in LiveKit's protocol, as used in participant permissions. */
const PROTO_CAMERA = 1;
const PROTO_MICROPHONE = 2;

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

/** Camera and screen tracks that are playing (published locally or subscribed remotely). */
function videosOf(room: Room): VideoTile[] {
  const local = room.localParticipant;
  return [local, ...room.remoteParticipants.values()].flatMap((p) =>
    [...p.trackPublications.values()]
      .filter((pub) => pub.kind === "video" && pub.track && !pub.isMuted)
      .map((pub) => ({
        key: `${p.identity}:${pub.trackSid}`,
        name: p.name || "Member",
        isLocal: p === local,
        screen: pub.source === "screen_share",
        track: pub.track!,
      })),
  );
}

/** App-wide, so a voice call survives navigating to text channels (like a phone call in the background). */
export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const room = useRef<Room | null>(null);
  // Each join gets a number; a join that was overtaken by a newer one (or a leave) stops after every await.
  const generation = useRef(0);
  const audio = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [channel, setChannel] = useState<VoiceValue["channel"]>(null);
  const [peers, setPeers] = useState<VoicePeer[]>([]);
  const [videos, setVideos] = useState<VideoTile[]>([]);
  const [canVideo, setCanVideo] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [muted, setMuted] = useState(true);
  const [canSpeak, setCanSpeak] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);

  const leave = useCallback(() => {
    generation.current += 1;
    const current = room.current;
    room.current = null;
    void current?.disconnect();
    setStatus("idle");
    setChannel(null);
    setPeers([]);
    setVideos([]);
    setCameraOn(false);
    setSharing(false);
    if (audio.current) audio.current.replaceChildren();
  }, []);

  const join = useCallback(
    async (target: { id: string; name: string; href: string }) => {
      leave();
      const mine = generation.current;
      const stale = () => generation.current !== mine;
      setError(null);
      setStatus("connecting");
      setChannel(target);
      const result = await joinVoice(target.id);
      if (stale()) return;
      if (!result.ok) {
        setError(result.error);
        setStatus("idle");
        setChannel(null);
        return;
      }
      // Loaded on demand: the WebRTC client is large and most visits never join voice.
      const { Room, RoomEvent, Track } = await import("livekit-client");
      if (stale()) return;
      const next = new Room({ adaptiveStream: true, dynacast: true });
      room.current = next;
      const refresh = () => {
        if (room.current !== next) return;
        setPeers(peersOf(next));
        setVideos(videosOf(next));
        setCameraOn(next.localParticipant.isCameraEnabled);
        setSharing(next.localParticipant.isScreenShareEnabled);
      };
      next
        .on(RoomEvent.ParticipantConnected, refresh)
        .on(RoomEvent.ParticipantDisconnected, refresh)
        .on(RoomEvent.ActiveSpeakersChanged, refresh)
        .on(RoomEvent.TrackMuted, refresh)
        .on(RoomEvent.TrackUnmuted, refresh)
        .on(RoomEvent.LocalTrackPublished, refresh)
        .on(RoomEvent.LocalTrackUnpublished, refresh)
        .on(RoomEvent.TrackPublished, refresh)
        .on(RoomEvent.TrackUnpublished, refresh)
        .on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio) audio.current?.appendChild(track.attach());
          refresh();
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => {
          track.detach().forEach((el) => el.remove());
          refresh();
        })
        .on(RoomEvent.AudioPlaybackStatusChanged, () => setAudioBlocked(!next.canPlaybackAudio))
        .on(RoomEvent.ParticipantPermissionsChanged, () => {
          // A moderator's change applies live: reflect what we may still publish.
          const permissions = next.localParticipant.permissions;
          const sources = permissions?.canPublishSources ?? [];
          const speak = !!permissions?.canPublish && (sources.length === 0 || sources.includes(PROTO_MICROPHONE));
          setCanSpeak(speak);
          setCanVideo(!!permissions?.canPublish && (sources.length === 0 || sources.includes(PROTO_CAMERA)));
          if (!speak) setMuted(true);
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
        if (stale()) {
          void next.disconnect();
          return;
        }
      } catch {
        if (room.current === next) {
          setError("Couldn't connect to voice. Check your connection and try again.");
          leave();
        }
        return;
      }
      setCanSpeak(result.data.canSpeak);
      setCanVideo(result.data.canVideo);
      setStatus("connected");
      // Autoplay rules may block remote audio until a user gesture; offer a button then.
      setAudioBlocked(!next.canPlaybackAudio);
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

  const toggleCamera = useCallback(async () => {
    const current = room.current;
    if (!current || !canVideo) return;
    try {
      await current.localParticipant.setCameraEnabled(!current.localParticipant.isCameraEnabled);
      setError(null);
    } catch {
      setError("Camera access was blocked or no camera was found.");
    }
    setCameraOn(current.localParticipant.isCameraEnabled);
    setVideos(videosOf(current));
  }, [canVideo]);

  const toggleScreenShare = useCallback(async () => {
    const current = room.current;
    if (!current || !canVideo) return;
    try {
      await current.localParticipant.setScreenShareEnabled(!current.localParticipant.isScreenShareEnabled, { audio: true });
      setError(null);
    } catch {
      // Cancelling the browser's picker lands here too; that's not worth an error message.
    }
    setSharing(current.localParticipant.isScreenShareEnabled);
    setVideos(videosOf(current));
  }, [canVideo]);

  const startAudio = useCallback(async () => {
    await room.current?.startAudio();
    setAudioBlocked(!(room.current?.canPlaybackAudio ?? true));
  }, []);

  useEffect(() => () => void room.current?.disconnect(), []);

  const value = useMemo(
    () => ({
      status, channel, peers, videos, muted, canSpeak, canVideo, cameraOn, sharing, error, audioBlocked,
      startAudio, join, leave, toggleMute, toggleCamera, toggleScreenShare,
    }),
    [status, channel, peers, videos, muted, canSpeak, canVideo, cameraOn, sharing, error, audioBlocked,
      startAudio, join, leave, toggleMute, toggleCamera, toggleScreenShare],
  );
  return (
    <VoiceContext.Provider value={value}>
      {children}
      {/* Remote audio plays from here, outside any page, so navigation doesn't cut it off. */}
      <div ref={audio} hidden />
    </VoiceContext.Provider>
  );
}
