"use client";

import { useEffect } from "react";

/** Registers /sw.js for the offline fallback page; Web Push reuses the same registration. */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => console.warn("Service worker registration failed", error));
  }, []);
  return null;
}
