/**
 * Content-free call notice from the personal event stream: who calls in which conversation, or that the call ended.
 * "cleared": this person answered or declined on another session. "declined": `callerId`/`callerName` turned down this call.
 */
export type DmCallNotice = { conversationId: string; state: "ringing" | "ended" | "cleared" | "declined"; callerId: string | null; callerName: string | null };
/** For "declined", `callerName` lists who declined (shown to people in the call). */
export type Ring = Readonly<{ conversationId: string; callerName: string; state: "ringing" | "missed" | "declined"; since: number }>;

/** Window event carrying a DmCallNotice, dispatched by the notifications stream. */
export const DM_CALL_EVENT = "opendiscord:dm-call";
/** An unanswered ring becomes a missed call after this long, even if the end event was lost. */
export const RING_TIMEOUT_MS = 45_000;
/** A "declined" notice disappears on its own after this long. */
export const DECLINED_NOTICE_MS = 10_000;

/** New ring list for a notice. `activeConversationId` is the call this browser is already in. */
export function applyCallNotice(rings: readonly Ring[], notice: DmCallNotice, now: number, activeConversationId?: string | null): Ring[] {
  const id = notice.conversationId;
  if (!id) return [...rings];
  // Declines are for people in the call, so they also apply to the active one.
  if (notice.state === "declined") {
    const name = notice.callerName ?? "Someone", previous = rings.find((ring) => ring.conversationId === id && ring.state === "declined");
    const names = previous ? (previous.callerName.split(", ").includes(name) ? previous.callerName : `${previous.callerName}, ${name}`) : name;
    return [...rings.filter((ring) => ring !== previous), { conversationId: id, callerName: names, state: "declined", since: now }];
  }
  if (id === activeConversationId) return [...rings];
  if (notice.state === "ringing") return [...rings.filter((ring) => ring.conversationId !== id), { conversationId: id, callerName: notice.callerName ?? "Someone", state: "ringing", since: now }];
  if (notice.state === "ended") return rings.map((ring) => (ring.conversationId === id && ring.state === "ringing" ? { ...ring, state: "missed" as const } : ring));
  if (notice.state === "cleared") return rings.filter((ring) => ring.conversationId !== id || ring.state === "declined");
  return [...rings];
}
const expired = (ring: Ring, now: number) => (ring.state === "ringing" && now - ring.since >= RING_TIMEOUT_MS) || (ring.state === "declined" && now - ring.since >= DECLINED_NOTICE_MS);
/** Same list when nothing expired, so React can skip a render. */
export function expireRings(rings: readonly Ring[], now: number): readonly Ring[] {
  if (!rings.some((ring) => expired(ring, now))) return rings;
  return rings.flatMap((ring) => (!expired(ring, now) ? [ring] : ring.state === "ringing" ? [{ ...ring, state: "missed" as const }] : []));
}
export const dismissRing = (rings: readonly Ring[], conversationId: string): Ring[] => rings.filter((ring) => ring.conversationId !== conversationId);
