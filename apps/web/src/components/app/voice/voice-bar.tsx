"use client";

import { MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useVoice } from "./voice-provider";

/** Compact controls for an ongoing call, wherever you are in the app. */
export function VoiceBar() {
  const voice = useVoice();
  if (voice.status === "idle" || !voice.channel) {
    // A call that ended on its own (removed, network) explains itself here too, not only on the voice page.
    return voice.error ? (
      <p role="alert" className="border-t border-white/5 px-3 py-2 text-xs text-destructive">{voice.error}</p>
    ) : null;
  }
  return (
    <section aria-label="Voice connection" className="flex items-center gap-1 border-t border-white/5 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-emerald-400">{voice.status === "connecting" ? "Connecting…" : "Voice connected"}</p>
        <Link href={voice.channel.href} className="block truncate text-xs text-zinc-400 hover:text-zinc-200">
          {voice.channel.name}
        </Link>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={voice.muted}
        disabled={!voice.canSpeak || voice.status !== "connected"}
        onClick={() => void voice.toggleMute()}
      >
        {voice.muted ? <MicOffIcon /> : <MicIcon />}
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Leave voice" onClick={voice.leave}>
        <PhoneOffIcon />
      </Button>
    </section>
  );
}
