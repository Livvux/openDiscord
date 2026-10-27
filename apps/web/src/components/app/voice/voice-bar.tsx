"use client";

import { MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useVoice, voiceStatus } from "./voice-provider";

/** Discord's "Voice Connected" strip on top of the user panel, on every page while in a call. */
export function VoiceBar() {
  const voice = useVoice();
  if (!voice.channel) return voice.error ? <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">{voice.error}</p> : null;
  const media = voice.view?.media;
  const canMic = media?.mediaState === "ready" && media.sources.includes("microphone") && !voice.pendingSources.includes("microphone");
  return <section aria-label="Voice connection" data-user-panel-wide className="grid gap-1 border-b px-2 py-2">
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1 px-1">
        <p className="truncate text-sm font-semibold text-emerald-400">{voiceStatus(voice.view, voice.joining)}</p>
        <Link href={voice.channel.href} className="block truncate text-xs text-muted-foreground hover:text-sidebar-foreground hover:underline">{voice.channel.name}</Link>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={media?.microphone ? "Mute" : "Unmute"} aria-pressed={!media?.microphone} disabled={!canMic} onClick={() => void voice.toggleSource("microphone")}>
        {media?.microphone ? <MicIcon /> : <MicOffIcon className="text-[#dc2626]" />}
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Disconnect" onClick={voice.leave}><PhoneOffIcon /></Button>
    </div>
    {voice.error && <p role="alert" className="px-1 text-xs text-destructive">{voice.error}</p>}
    {voice.view?.media.audioBlocked && <Button size="sm" onClick={() => void voice.startAudio()}>Enable audio playback</Button>}
  </section>;
}
