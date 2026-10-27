// Shared by the account menu, presence dots and the friends list.
export type PresenceStatus = "online" | "idle" | "dnd";
export type PresenceChoice = PresenceStatus | "invisible";

export const PRESENCE_LABEL: Record<PresenceChoice, string> = {
  online: "Online",
  idle: "Idle",
  dnd: "Do not disturb",
  invisible: "Invisible",
};

// Discord's status colours.
export const PRESENCE_DOT: Record<PresenceChoice, string> = {
  online: "bg-[#43a25a]",
  idle: "bg-[#ca9654]",
  dnd: "bg-[#d83a42]",
  invisible: "bg-[#82838b]",
};
