"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useVoice, voiceStatus } from "./voice-provider";
import { VoiceSourceButton } from "./voice-room";

export function VoiceBar() {
  const voice = useVoice();
  if (!voice.channel) return voice.error ? <p role="alert" className="border-t px-3 py-2 text-xs text-destructive">{voice.error}</p> : null;
  return <section aria-label="Voice connection" className="grid gap-2 border-t px-3 py-2">
    <p className="text-xs" role="status">{voiceStatus(voice.view, voice.joining)}</p>
    <Link href={voice.channel.href} className="truncate text-xs underline">{voice.channel.name}</Link>
    {voice.error && <p role="alert" className="text-xs text-destructive">{voice.error}</p>}
    {voice.view?.media.audioBlocked && <Button size="sm" onClick={() => void voice.startAudio()}>Enable audio playback</Button>}
    <div className="flex flex-wrap gap-1"><VoiceSourceButton source="microphone" sidebar /><Button size="sm" variant="destructive" onClick={voice.leave}>Leave Voice</Button></div>
  </section>;
}
