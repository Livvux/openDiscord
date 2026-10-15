"use client";

import { useSyncExternalStore, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { DESKTOP_NOTIFICATIONS_KEY } from "../notifications-provider";

const supported = () => typeof Notification !== "undefined";
const subscribeStorage = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};

/** Desktop notifications for mentions; stored per browser, off by default. */
export function NotificationSettings() {
  const stored = useSyncExternalStore(subscribeStorage, () => localStorage.getItem(DESKTOP_NOTIFICATIONS_KEY) === "on", () => false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const on = (enabled ?? stored) && supported() && Notification.permission === "granted";

  async function toggle(next: boolean) {
    setMessage(null);
    if (next) {
      if (!supported()) return setMessage("This browser doesn't support desktop notifications.");
      const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      if (permission !== "granted") return setMessage("Notifications are blocked for this site. Allow them in your browser settings.");
    }
    localStorage.setItem(DESKTOP_NOTIFICATIONS_KEY, next ? "on" : "off");
    setEnabled(next);
  }

  return (
    <div className="grid gap-2">
      <label className="flex items-center gap-3 text-sm">
        <Switch checked={on} onCheckedChange={(v) => void toggle(v)} aria-describedby="desktop-notifications-help" />
        Desktop notifications when someone mentions me
      </label>
      <p id="desktop-notifications-help" className="text-xs text-muted-foreground">
        Shown while openDiscord is open in a tab, for this browser only. They include the sender, channel and the start of the message.
      </p>
      {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
    </div>
  );
}
