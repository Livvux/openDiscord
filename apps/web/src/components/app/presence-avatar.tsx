"use client";

import { Avatar } from "./avatar";
import { useOnline } from "./presence-provider";

interface PresenceAvatarProps {
  userId: string;
  name: string;
  size?: "sm" | "md";
  /** Also say "online" to screen readers (member lists; not every chat message). */
  announce?: boolean;
}

/** Avatar with an online dot. */
export function PresenceAvatar({ userId, name, size, announce = false }: PresenceAvatarProps) {
  const online = useOnline(userId);
  return (
    <span className="relative inline-grid">
      <Avatar name={name} size={size} />
      {online && (
        <>
          <span aria-hidden className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-emerald-400 ring-2 ring-background" />
          {announce && <span className="sr-only">(online)</span>}
        </>
      )}
    </span>
  );
}
