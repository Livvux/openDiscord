"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { FRIENDS_CHANGED_EVENT } from "../notifications-provider";

// Presence has no events; friend requests and message requests arrive live through the personal stream.
const PRESENCE_REFRESH_MS = 60_000;

/** Friends' presence and requests come from the server render; refresh it on changes and while Home is visible. */
export function HomeRefresher() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => router.refresh();
    const timer = window.setInterval(() => document.visibilityState === "visible" && refresh(), PRESENCE_REFRESH_MS);
    window.addEventListener(FRIENDS_CHANGED_EVENT, refresh);
    return () => { window.clearInterval(timer); window.removeEventListener(FRIENDS_CHANGED_EVENT, refresh); };
  }, [router]);
  return null;
}
