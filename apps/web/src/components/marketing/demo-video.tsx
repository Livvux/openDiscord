"use client";

import { useEffect, useRef, useState } from "react";
import { PlayToggle } from "./play-toggle";

type Props = { src: string; poster: string; label: string; labels: { play: string; pause: string }; width: number; height: number; priority?: boolean };

/** A muted, looping product recording. Plays only while on screen and never autoplays under reduced motion. */
export function DemoVideo({ src, poster, label, labels, width, height, priority }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const manuallyPaused = useRef(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry.isIntersecting && !reduce && !manuallyPaused.current) video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0.15 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  const toggle = () => {
    const video = ref.current;
    if (!video) return;
    manuallyPaused.current = !video.paused;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };

  return (
    <div className="relative overflow-hidden rounded-[1.25rem] bg-dark ring-1 ring-ink/10 sm:rounded-[1.75rem]">
      <video
        ref={ref}
        src={src}
        poster={poster}
        width={width}
        height={height}
        muted
        loop
        playsInline
        preload={priority ? "auto" : "metadata"}
        aria-label={label}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        className="block h-auto w-full"
      />
      <PlayToggle playing={playing} onToggle={toggle} labels={labels} />
    </div>
  );
}
