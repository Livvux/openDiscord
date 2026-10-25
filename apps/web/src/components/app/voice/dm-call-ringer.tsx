"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DESKTOP_NOTIFICATIONS_KEY } from "@/components/app/notifications-provider";
import { playAppSound } from "@/lib/sounds/app-sounds";
import { useRepeatingSound } from "@/lib/sounds/use-repeating-sound";
import { applyCallNotice, dismissRing, DM_CALL_EVENT, expireRings, RING_TIMEOUT_MS, type DmCallNotice, type Ring } from "./dm-call-ring";
import { useVoice } from "./voice-provider";

const conversationHref = (id: string) => `/app/messages?c=${encodeURIComponent(id)}`;
// Tells the caller and this person's other sessions; the ring is already gone here, so a failure only costs that feedback.
const declineCall = (conversationId: string) => fetch("/api/dm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "call-decline", id: conversationId }) })
  .then((response) => { if (!response.ok) console.warn("[call] decline was not delivered", response.status); }, (error: unknown) => console.warn("[call] decline was not delivered", error));

/** Incoming and missed direct-message calls. Accepting is the explicit Voice join consent. */
export function DmCallRinger() {
  const router = useRouter();
  const voice = useVoice();
  const [rings, setRings] = useState<readonly Ring[]>([]);
  const activeId = voice.channel?.dm ? voice.channel.id : null;
  const activeCall = useRef<string | null>(null);
  useEffect(() => { activeCall.current = activeId; }, [activeId]);
  useEffect(() => {
    const onCall = (event: Event) => {
      const notice = (event as CustomEvent<DmCallNotice>).detail;
      setRings((current) => applyCallNotice(current, notice, Date.now(), activeCall.current));
      if (notice.state === "declined") playAppSound("declined");
      // A background tab still announces the call (sender name only), if the person opted in.
      if (notice.state === "ringing" && document.visibilityState !== "visible" && typeof Notification !== "undefined" && Notification.permission === "granted" && localStorage.getItem(DESKTOP_NOTIFICATIONS_KEY) === "on") {
        const n = new Notification(notice.callerName ?? "Private call", { body: "Incoming call", tag: `call:${notice.conversationId}` });
        n.onclick = () => { window.focus(); router.push(conversationHref(notice.conversationId)); n.close(); };
      }
    };
    window.addEventListener(DM_CALL_EVENT, onCall);
    const timer = window.setInterval(() => setRings((current) => expireRings(current, Date.now())), 5000);
    return () => { window.removeEventListener(DM_CALL_EVENT, onCall); window.clearInterval(timer); };
  }, [router]);
  const visible = rings.filter((ring) => ring.conversationId !== activeId || ring.state === "declined");
  useRepeatingSound(visible.some((ring) => ring.state === "ringing"), "ring", RING_TIMEOUT_MS);
  if (!visible.length) return null;
  return <section aria-label="Calls" className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-50 grid w-80 max-w-[calc(100vw-2rem)] gap-2">
    {visible.map((ring) => ring.state === "ringing"
      ? <div key={ring.conversationId} role="group" aria-label={`Incoming call from ${ring.callerName}`} className="grid gap-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg">
        <p className="font-semibold">{ring.callerName} is calling</p>
        <p className="text-xs text-muted-foreground">Accepting creates a temporary encrypted Voice device for this browser session. You then compare symbols with each participant and admit them. Your microphone stays off until you turn it on.</p>
        <div className="flex gap-2">
          <Button disabled={!voice.authenticated} onClick={() => { setRings((current) => dismissRing(current, ring.conversationId)); router.push(conversationHref(ring.conversationId)); void voice.join({ id: ring.conversationId, name: ring.callerName, href: conversationHref(ring.conversationId), dm: true }); }}>Accept call</Button>
          <Button variant="outline" onClick={() => { setRings((current) => dismissRing(current, ring.conversationId)); void declineCall(ring.conversationId); }}>Decline</Button>
        </div>
      </div>
      : ring.state === "declined"
      ? <div key={ring.conversationId} role="status" className="flex items-center justify-between gap-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg">
        <p className="font-semibold">{ring.callerName} declined the call</p>
        <Button variant="ghost" onClick={() => setRings((current) => dismissRing(current, ring.conversationId))}>Dismiss</Button>
      </div>
      : <div key={ring.conversationId} role="group" aria-label={`Missed call from ${ring.callerName}`} className="grid gap-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg">
        <p className="font-semibold">Missed call from {ring.callerName}</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => { setRings((current) => dismissRing(current, ring.conversationId)); router.push(conversationHref(ring.conversationId)); }}>Open conversation</Button>
          <Button variant="ghost" onClick={() => setRings((current) => dismissRing(current, ring.conversationId))}>Dismiss</Button>
        </div>
      </div>)}
  </section>;
}
