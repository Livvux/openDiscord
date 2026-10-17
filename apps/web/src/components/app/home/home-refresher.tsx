"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const REFRESH_MS = 60_000;

/** Friends' presence and requests come from the server render; refresh it while Home is visible. */
export function HomeRefresher() {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => document.visibilityState === "visible" && router.refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [router]);
  return null;
}
