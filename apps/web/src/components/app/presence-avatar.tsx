"use client";

import { PRESENCE_DOT, PRESENCE_LABEL, type PresenceStatus } from "@/lib/presence";
import { Avatar } from "./avatar";
import { usePresence } from "./presence-provider";

interface PresenceAvatarProps {
  userId: string;
  name: string;
  size?: "sm" | "md";
  /** Also say the status to screen readers (member lists; not every chat message). */
  announce?: boolean;
  /** Known status outside a community (friends list); otherwise read from the community's presence. */
  status?: PresenceStatus | null;
}

/** Avatar with a status dot. */
export function PresenceAvatar({ userId, name, size, announce = false, status }: PresenceAvatarProps) {
  const polled = usePresence(userId);
  const shown = status === undefined ? polled : status;
  return (
    <span className="relative inline-grid">
      <Avatar name={name} size={size} />
      {shown && (
        <>
          <span aria-hidden className={`absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-background ${PRESENCE_DOT[shown]}`} />
          {announce && <span className="sr-only">({PRESENCE_LABEL[shown].toLowerCase()})</span>}
        </>
      )}
    </span>
  );
}
