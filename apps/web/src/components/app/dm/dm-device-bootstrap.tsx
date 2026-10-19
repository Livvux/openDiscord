"use client";

import { useEffect } from "react";
import { privateMessaging } from "@/lib/dm/client";
import { persistDmStorage } from "@/lib/dm/storage-persistence";

const readyKey = (userId: string) => `opendiscord.dm.ready:${userId}`;

/**
 * Sets up this browser's encryption device on a first visit, so friends can message you before
 * you ever open a conversation. Repeats until one setup completed (a navigation can interrupt it).
 */
export function DmDeviceBootstrap({ userId }: { userId: string }) {
  useEffect(() => {
    const saved = localStorage.getItem(`opendiscord.dm.device:${userId}`);
    // Enrolled: ask the browser to keep the store holding this device's keys (Safari may evict it otherwise).
    if (saved && localStorage.getItem(readyKey(userId)) === saved) { void persistDmStorage(); return; }
    privateMessaging(userId).then(
      () => { const current = localStorage.getItem(`opendiscord.dm.device:${userId}`); if (current) localStorage.setItem(readyKey(userId), current); void persistDmStorage(); },
      // Best effort: the messages page opens the same client and shows any error with a retry.
      () => undefined,
    );
  }, [userId]);
  return null;
}
