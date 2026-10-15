"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";

const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** Web Push on this device (mentions while openDiscord isn't open). Off by default. */
export function PushSettings({ publicKey }: { publicKey: string }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!supported()) return;
    void navigator.serviceWorker.getRegistration("/sw.js").then((reg) => reg?.pushManager.getSubscription()).then((sub) => setOn(!!sub));
  }, []);

  async function toggle(next: boolean) {
    setMessage(null);
    if (!supported()) return setMessage("This browser doesn't support push notifications.");
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      if (next) {
        if ((await Notification.requestPermission()) !== "granted") {
          setMessage("Notifications are blocked for this site. Allow them in your browser settings.");
          return;
        }
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
        const res = await fetch("/api/me/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
        if (!res.ok) {
          await sub.unsubscribe();
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setMessage(body?.error ?? "Couldn't turn on push notifications.");
          return;
        }
        setOn(true);
      } else {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await fetch("/api/me/push", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
          await sub.unsubscribe();
        }
        setOn(false);
      }
    } catch {
      setMessage("Couldn't change push notifications on this device.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <label className="flex items-center gap-3 text-sm">
        <Switch checked={on} disabled={busy} onCheckedChange={(v) => void toggle(v)} aria-describedby="push-help" />
        Push notifications for mentions on this device
      </label>
      <p id="push-help" className="text-xs text-muted-foreground">
        Also when openDiscord is closed. Delivered through your browser maker&apos;s push service; the content is encrypted so that service can&apos;t read it.
      </p>
      {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
    </div>
  );
}
