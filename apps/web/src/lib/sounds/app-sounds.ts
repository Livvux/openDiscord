import { playSound, type Tune } from "./react-bits-sound";
import { recipes } from "./recipes";

export type AppSound = keyof typeof recipes;

/** Local preference, on unless set to "off". */
export const SOUNDS_KEY = "opendiscord:sounds";
export const soundsEnabled = (): boolean => localStorage.getItem(SOUNDS_KEY) !== "off";

export function playAppSound(name: AppSound, tune?: Tune): void {
  if (typeof window === "undefined" || !soundsEnabled()) return;
  // Rejects only when the browser blocks audio before the first user gesture; a missed cue is fine.
  playSound(recipes[name], tune).catch(() => {});
}
