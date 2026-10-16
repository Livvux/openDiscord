"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { VoiceMediaTile, VoiceSource } from "@/lib/voice/media-session";
import { useVoice, voiceStatus } from "./voice-provider";

function Video({ tile, name }: { tile: VoiceMediaTile; name: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const { mountVideo } = useVoice();
  useEffect(() => { if (ref.current) return mountVideo(tile.id, ref.current); }, [tile.id, mountVideo]);
  return <figure className="relative overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
    <video ref={ref} aria-label={`${name}${tile.isLocal ? " (you)" : ""}${tile.source === "screen_share" ? " screen" : " camera"}`} muted={tile.isLocal} playsInline className={`aspect-video w-full object-contain ${tile.isLocal && tile.source === "camera" ? "-scale-x-100" : ""}`} />
    <figcaption className="px-2 py-1 text-xs text-zinc-100">{name}{tile.isLocal ? " (you)" : ""}{tile.source === "screen_share" ? " · screen" : ""}</figcaption>
  </figure>;
}
export function VoiceSourceButton({ source, sidebar = false }: { source: VoiceSource; sidebar?: boolean }) {
  const voice = useVoice(), media = voice.view?.media;
  const active = source === "microphone" ? media?.microphone : source === "camera" ? media?.camera : media?.screenShare;
  const label = source === "microphone" ? active ? "Mute microphone" : "Unmute microphone" : source === "camera" ? active ? "Stop camera" : "Camera" : active ? "Stop sharing" : "Share screen";
  return <Button size={sidebar ? "sm" : "default"} variant="secondary" aria-pressed={!!active} disabled={media?.mediaState !== "ready" || !media.sources.includes(source) || voice.pendingSources.includes(source)} onClick={() => void voice.toggleSource(source)}>{label}</Button>;
}
export function VoiceRoom({ channel, href, canConnect }: { channel: { id: string; name: string }; href: string; canConnect: boolean }) {
  const voice = useVoice();
  const [consent, setConsent] = useState(false);
  const here = voice.channel?.id === channel.id;
  const view = here ? voice.view : null;
  const active = here && (voice.joining || !!view && view.state !== "ended");
  const media = view?.media;
  const others = view?.roster.filter(member => member.memberId !== view.selfMemberId) ?? [];
  const allAdmitted = !!view?.keysPrepared && others.every(member => view.admittedMemberIds.includes(member.memberId));
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center gap-5 overflow-y-auto p-4 md:p-6">
    <header className="text-center"><h2 className="text-xl font-semibold">{channel.name}</h2><p className="mt-2 text-sm text-muted-foreground" role="status">{voiceStatus(view, here && voice.joining)}</p></header>
    {view && view.state !== "ended" && <section aria-label="Full Voice audience" className="grid w-full max-w-2xl gap-3">
      <h3 className="font-semibold">Full Voice audience</h3>
      <p className="text-sm text-muted-foreground">Verify each temporary device over another trusted channel. Confirm on both browsers, then admit each participant. Messaging verification does not verify Voice.</p>
      <ul className="grid gap-3">{view.roster.map(member => {
        const self = member.memberId === view.selfMemberId;
        const sas = [...view.sas].reverse().find(flow => flow.peer.memberId === member.memberId && !flow.cancelled);
        const admitted = view.admittedMemberIds.includes(member.memberId);
        return <li key={member.memberId} aria-label={`Voice participant ${member.displayName}`} className="min-w-0 rounded-lg border p-3">
          <p className="font-medium">{member.displayName}{self ? " (you)" : ""}</p>
          <p className="break-all text-xs text-muted-foreground">Account {member.userId} · Voice device {member.voiceDeviceId}</p>
          {!self && <div className="mt-3 grid gap-2">
            {admitted ? <p>Admitted for this exact device.</p> : sas?.done ? <Button disabled={voice.busy} onClick={() => void voice.admit(member.memberId)}>Admit this verified participant</Button> : <>
              {!sas && (view.selfMemberId < member.memberId ? <Button disabled={voice.busy || !view.keysPrepared} onClick={() => void voice.requestVerification(member.memberId)}>Request Voice verification</Button> : <p className="text-sm">Waiting for this participant to request verification.</p>)}
              {sas && !sas.done && <>
                {!sas.ready && !sas.weStarted && <Button disabled={voice.busy} onClick={() => void voice.verificationStep(sas.handle, "accept")}>Accept Voice verification</Button>}
                {sas.ready && !sas.hasSas && sas.weStarted && <Button disabled={voice.busy} onClick={() => void voice.verificationStep(sas.handle, "start")}>Start SAS comparison</Button>}
                {sas.hasSas && !sas.sasAccepted && !sas.weStarted && <Button disabled={voice.busy} onClick={() => void voice.verificationStep(sas.handle, "accept-sas")}>Accept SAS comparison</Button>}
                {sas.emoji && <div aria-label="Voice comparison" className="grid gap-2"><p className="text-sm">Compare these seven symbols and descriptions with this participant over another trusted channel.</p><ol className="flex flex-wrap gap-3" aria-label="Voice SAS symbols">{sas.emoji.map((emoji, index) => <li key={index} className="text-center"><span className="block text-2xl" aria-hidden>{emoji.symbol}</span><span className="text-xs">{emoji.description}</span></li>)}</ol><Button disabled={voice.busy || sas.confirmed} onClick={() => void voice.verificationStep(sas.handle, "confirm")}>{sas.confirmed ? "Waiting for their confirmation" : "I compared all seven symbols — they match"}</Button></div>}
                <Button variant="outline" disabled={voice.busy} onClick={() => void voice.verificationStep(sas.handle, "cancel")}>Cancel Voice verification</Button>
              </>}
            </>}
          </div>}
        </li>;
      })}</ul>
      {media?.mediaState !== "ready" && <><p className="text-sm">Allow every account and exact device listed above. A changed audience stops capture and requires fresh consent. Microphone, camera and screen stay off until you activate them.</p><Button disabled={voice.busy || !allAdmitted || media?.mediaState === "keying"} onClick={() => void voice.confirmFullRoster()}>Allow this audience and prepare encrypted media</Button></>}
    </section>}
    {media?.mediaState === "ready" && <><div className="flex flex-wrap justify-center gap-2"><VoiceSourceButton source="microphone" /><VoiceSourceButton source="camera" /><VoiceSourceButton source="screen_share" /></div>{!media.sources.includes("microphone") && <p className="text-sm text-muted-foreground">You can listen here, but not speak.</p>}</>}
    {media && media.tiles.some(tile => tile.kind === "video") && <section aria-label="Video" className="grid w-full max-w-5xl gap-3 sm:grid-cols-2">{media.tiles.filter(tile => tile.kind === "video").map(tile => <Video key={tile.id} tile={tile} name={view?.roster.find(member => member.memberId === tile.memberId)?.displayName ?? "Participant"} />)}</section>}
    {here && voice.error && <p role="alert" className="max-w-xl text-sm text-destructive">{voice.error}</p>}
    {here && voice.error?.includes("Devices and recovery") && <Link href="/app/messages" className="underline">Open encrypted messages — Devices and recovery</Link>}
    {media?.audioBlocked && <Button onClick={() => void voice.startAudio()}>Enable audio playback</Button>}
    {active ? <Button variant="destructive" onClick={voice.leave}>Leave Voice</Button> : !canConnect ? <p>You don&apos;t have permission to join this voice channel.</p> : consent ? <section aria-label="Voice join consent" className="grid w-full max-w-xl gap-3 rounded-lg border p-4">
      <h3 className="font-semibold">Join encrypted Voice?</h3><p className="text-sm">Create a temporary Voice device for this browser session. Every participant must separately verify, admit and consent to the full audience. Your microphone stays off until you activate it. The server sees participants and timing; a compromised browser can access media.</p>
      <Button disabled={!voice.authenticated} onClick={() => { setConsent(false); void voice.join({ ...channel, href }); }}>Create temporary device and join</Button><Button variant="outline" onClick={() => setConsent(false)}>Cancel joining Voice</Button>
    </section> : <Button disabled={!voice.authenticated} onClick={() => setConsent(true)}>Join voice</Button>}
  </div>;
}
