"use client";

import { PhoneIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useVoice } from "./voice-provider";
import { VoiceRoom } from "./voice-room";

type Conversation = { id: string; name: string };
const href = (id: string) => `/app/messages?c=${encodeURIComponent(id)}`;
const inThisCall = (voice: ReturnType<typeof useVoice>, id: string) => !!voice.channel?.dm && voice.channel.id === id;

/** Conversation header control: opens the encrypted call panel (the call itself needs explicit join consent there). */
export function DmCallButton({ conversation, open, onToggle }: { conversation: Conversation; open: boolean; onToggle: () => void }) {
  const voice = useVoice();
  const here = inThisCall(voice, conversation.id);
  return <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" title={here ? "In call" : "Start voice call"} aria-expanded={open || here} disabled={here} onClick={onToggle}><PhoneIcon aria-hidden /><span className="sr-only">{here ? "In call" : "Call"}</span></Button>;
}

/** The same encrypted Voice room as a voice channel, scoped to this conversation's current members. */
export function DmCallPanel({ conversation, open }: { conversation: Conversation; open: boolean }) {
  const voice = useVoice();
  if (!open && !inThisCall(voice, conversation.id)) return null;
  return <section aria-label="Encrypted call" className="flex max-h-[60dvh] min-h-0 shrink-0 border-b">
    <VoiceRoom channel={{ ...conversation, dm: true }} href={href(conversation.id)} canConnect askConsent />
  </section>;
}
