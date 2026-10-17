// Shared by the account menu, presence dots and the friends list.
export type PresenceStatus = "online" | "idle" | "dnd";
export type PresenceChoice = PresenceStatus | "invisible";

export const PRESENCE_LABEL: Record<PresenceChoice, string> = {
  online: "Online",
  idle: "Idle",
  dnd: "Do not disturb",
  invisible: "Invisible",
};

export const PRESENCE_DOT: Record<PresenceChoice, string> = {
  online: "bg-emerald-400",
  idle: "bg-amber-400",
  dnd: "bg-red-500",
  invisible: "bg-zinc-500",
};
