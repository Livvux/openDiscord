"use client";

import { useEffect } from "react";
import { playAppSound, type AppSound } from "./app-sounds";

const REPEAT_MS = 3000;

/** Plays `name` now and every few seconds while `on`, for at most `limitMs`. */
export function useRepeatingSound(on: boolean, name: AppSound, limitMs: number, volume = 0): void {
  useEffect(() => {
    if (!on) return;
    const started = Date.now();
    playAppSound(name, { volume });
    const timer = window.setInterval(() => {
      if (Date.now() - started >= limitMs) window.clearInterval(timer);
      else playAppSound(name, { volume });
    }, REPEAT_MS);
    return () => window.clearInterval(timer);
  }, [on, name, limitMs, volume]);
}
