"use client";

import { useEffect, useRef } from "react";

interface TurnstileApi {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptLoad: Promise<void> | undefined;
function loadScript() {
  scriptLoad ??= new Promise<void>((resolve, reject) => {
    const script = Object.assign(document.createElement("script"), { src: SCRIPT_SRC, async: true });
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoad = undefined;
      reject(new Error("Turnstile failed to load"));
    };
    document.head.append(script);
  });
  return scriptLoad;
}

interface TurnstileProps {
  siteKey: string;
  action: string;
  /** A fresh token, or null when it expired or the challenge failed. Tokens are single-use. */
  onToken: (token: string | null) => void;
  onError: (message: string) => void;
}

/** Cloudflare Turnstile challenge. Remount it (change `key`) to get a new token after a failed submit. */
export function Turnstile({ siteKey, action, onToken, onError }: TurnstileProps) {
  const ref = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onToken, onError });
  useEffect(() => {
    callbacks.current = { onToken, onError };
  });

  useEffect(() => {
    let widget: string | undefined;
    let cancelled = false;
    loadScript().then(
      () => {
        if (cancelled || !ref.current || !window.turnstile) return;
        widget = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          action,
          theme: "dark",
          size: "flexible",
          callback: (token: string) => callbacks.current.onToken(token),
          "expired-callback": () => callbacks.current.onToken(null),
          "error-callback": () => {
            callbacks.current.onToken(null);
            callbacks.current.onError("The anti-spam check failed. Reload the page and try again.");
          },
        });
      },
      () => callbacks.current.onError("The anti-spam check couldn't load. Check your connection or content blocker."),
    );
    return () => {
      cancelled = true;
      if (widget) window.turnstile?.remove(widget);
    };
  }, [siteKey, action]);

  return <div ref={ref} className="min-h-[65px]" />;
}
