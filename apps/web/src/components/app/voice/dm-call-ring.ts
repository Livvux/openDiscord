/** Content-free call notice from the personal event stream: who calls in which conversation, or that the call ended. */
export type DmCallNotice = { conversationId: string; state: "ringing" | "ended"; callerId: string | null; callerName: string | null };
export type Ring = Readonly<{ conversationId: string; callerName: string; state: "ringing" | "missed"; since: number }>;

/** Window event carrying a DmCallNotice, dispatched by the notifications stream. */
export const DM_CALL_EVENT = "opendiscord:dm-call";
/** An unanswered ring becomes a missed call after this long, even if the end event was lost. */
export const RING_TIMEOUT_MS = 45_000;

/** New ring list for a notice. `activeConversationId` is the call this browser is already in. */
export function applyCallNotice(rings: readonly Ring[], notice: DmCallNotice, now: number, activeConversationId?: string | null): Ring[] {
  const id = notice.conversationId;
  if (!id || id === activeConversationId) return [...rings];
  if (notice.state === "ringing") return [...rings.filter((ring) => ring.conversationId !== id), { conversationId: id, callerName: notice.callerName ?? "Someone", state: "ringing", since: now }];
  if (notice.state === "ended") return rings.map((ring) => (ring.conversationId === id && ring.state === "ringing" ? { ...ring, state: "missed" as const } : ring));
  return [...rings];
}
/** Same list when nothing expired, so React can skip a render. */
export function expireRings(rings: readonly Ring[], now: number): readonly Ring[] {
  if (!rings.some((ring) => ring.state === "ringing" && now - ring.since >= RING_TIMEOUT_MS)) return rings;
  return rings.map((ring) => (ring.state === "ringing" && now - ring.since >= RING_TIMEOUT_MS ? { ...ring, state: "missed" as const } : ring));
}
export const dismissRing = (rings: readonly Ring[], conversationId: string): Ring[] => rings.filter((ring) => ring.conversationId !== conversationId);
