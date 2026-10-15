"use client";

import { MicIcon, MicOffIcon, PhoneOffIcon, Volume2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { listVoiceParticipants } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import type { VoiceParticipant } from "@/server/voice";
import { Avatar } from "../avatar";
import { useVoice } from "./voice-provider";

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

export function VoiceRoom({ channel, href, canConnect }: VoiceRoomProps) {
  const voice = useVoice();
  const here = voice.channel?.id === channel.id;
  const connected = here && voice.status === "connected";
  const waiting = useParticipants(channel.id, !connected);
  const people = connected
    ? voice.peers
    : waiting.map((p) => ({ id: p.id, name: p.name, speaking: false, muted: false, isLocal: false }));

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 p-6">
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
      {voice.error && <p role="alert" className="max-w-md text-center text-sm text-destructive">{voice.error}</p>}
      {!canConnect ? (
        <p className="text-sm text-zinc-400">You don&apos;t have permission to join this voice channel.</p>
      ) : connected ? (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void voice.toggleMute()} disabled={!voice.canSpeak} aria-pressed={voice.muted}>
            {voice.muted ? <MicOffIcon /> : <MicIcon />}
            {voice.muted ? "Unmute" : "Mute"}
          </Button>
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
