"use client";

import { MicIcon, MicOffIcon, MonitorUpIcon, PhoneOffIcon, VideoIcon, VideoOffIcon, Volume2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { listVoiceParticipants } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import type { VoiceParticipant } from "@/server/voice";
import { Avatar } from "../avatar";
import { useVoice, type VideoTile } from "./voice-provider";

const POLL_MS = 15_000;

interface VoiceRoomProps {
  channel: { id: string; name: string };
  href: string;
  canConnect: boolean;
}

/** Who's in the channel before you join; polled because it's only shown while this page is open. */
function useParticipants(channelId: string, enabled: boolean) {
  const [list, setList] = useState<VoiceParticipant[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = () => void listVoiceParticipants(channelId).then((r) => active && r.ok && setList(r.data));
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [channelId, enabled]);
  return list;
}

function Video({ tile }: { tile: VideoTile }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    tile.track.attach(el);
    return () => void tile.track.detach(el);
  }, [tile.track]);
  return (
    <figure className="relative overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
      {/* Your own camera is mirrored, like a mirror; screens never are. */}
      <video ref={ref} muted={tile.isLocal} playsInline className={`aspect-video w-full object-contain ${tile.isLocal && !tile.screen ? "-scale-x-100" : ""}`} />
      <figcaption className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-zinc-100">
        {tile.name}{tile.isLocal ? " (you)" : ""}{tile.screen ? " · screen" : ""}
      </figcaption>
    </figure>
  );
}

export function VoiceRoom({ channel, href, canConnect }: VoiceRoomProps) {
  const voice = useVoice();
  const here = voice.channel?.id === channel.id;
  const connected = here && voice.status === "connected";
  const waiting = useParticipants(channel.id, !connected);
  const people = connected
    ? voice.peers
    : waiting.map((p) => ({ id: p.id, name: p.name, speaking: false, muted: false, isLocal: false }));

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto p-6">
      <div className="text-center">
        <Volume2Icon aria-hidden className="mx-auto size-8 text-zinc-500" />
        <h2 className="mt-2 text-xl font-semibold text-zinc-100">{channel.name}</h2>
        <p className="text-sm text-zinc-400" role="status">
          {connected ? "You're connected." : here && voice.status === "connecting" ? "Connecting…" : people.length === 0 ? "Nobody is here yet." : `${people.length} in the channel`}
        </p>
      </div>
      {people.length > 0 && (
        <ul aria-label={`People in ${channel.name}`} className="flex max-w-xl flex-wrap justify-center gap-4">
          {people.map((p) => (
            <li key={p.id} className="flex w-24 flex-col items-center gap-1 text-center">
              <span className={`rounded-full p-0.5 ring-2 ${p.speaking ? "ring-emerald-400" : "ring-transparent"}`}>
                <Avatar name={p.name} />
              </span>
              <span className="w-full truncate text-xs text-zinc-300">
                {p.name}
                {p.isLocal && " (you)"}
              </span>
              <span className="sr-only">{p.speaking ? "speaking" : ""}{p.muted && connected ? " muted" : ""}</span>
              {p.muted && connected && <MicOffIcon aria-hidden className="size-3 text-zinc-500" />}
            </li>
          ))}
        </ul>
      )}
      {connected && voice.videos.length > 0 && (
        <section aria-label="Video" className={`grid w-full max-w-5xl gap-3 ${voice.videos.length > 1 ? "sm:grid-cols-2" : ""}`}>
          {voice.videos.map((tile) => <Video key={tile.key} tile={tile} />)}
        </section>
      )}
      {voice.error && <p role="alert" className="max-w-md text-center text-sm text-destructive">{voice.error}</p>}
      {!canConnect ? (
        <p className="text-sm text-zinc-400">You don&apos;t have permission to join this voice channel.</p>
      ) : connected ? (
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="secondary" onClick={() => void voice.toggleMute()} disabled={!voice.canSpeak} aria-pressed={voice.muted}>
            {voice.muted ? <MicOffIcon /> : <MicIcon />}
            {voice.muted ? "Unmute" : "Mute"}
          </Button>
          {voice.canVideo && (
            <>
              <Button variant="secondary" onClick={() => void voice.toggleCamera()} aria-pressed={voice.cameraOn}>
                {voice.cameraOn ? <VideoOffIcon /> : <VideoIcon />}
                {voice.cameraOn ? "Stop camera" : "Camera"}
              </Button>
              <Button variant="secondary" onClick={() => void voice.toggleScreenShare()} aria-pressed={voice.sharing}>
                <MonitorUpIcon />
                {voice.sharing ? "Stop sharing" : "Share screen"}
              </Button>
            </>
          )}
          <Button variant="destructive" onClick={voice.leave}>
            <PhoneOffIcon />
            Leave
          </Button>
        </div>
      ) : (
        <Button size="lg" disabled={here && voice.status === "connecting"} onClick={() => void voice.join({ id: channel.id, name: channel.name, href })}>
          Join voice
        </Button>
      )}
      {connected && !voice.canSpeak && <p className="text-sm text-zinc-400">You can listen here, but not speak.</p>}
    </div>
  );
}
