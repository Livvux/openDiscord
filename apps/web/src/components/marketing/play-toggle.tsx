import { Pause, Play } from "lucide-react";

/** Pause control for looping product videos (WCAG 2.2.2). Sits on top of dark footage, so it is always dark. */
export function PlayToggle({ playing, onToggle, labels }: { playing: boolean; onToggle: () => void; labels: { play: string; pause: string } }) {
  const Icon = playing ? Pause : Play;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={playing ? labels.pause : labels.play}
      className="absolute right-3 bottom-3 grid size-9 place-items-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
    >
      <Icon aria-hidden className="size-4 fill-current" />
    </button>
  );
}
