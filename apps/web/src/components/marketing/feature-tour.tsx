"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PlayToggle } from "./play-toggle";

export type TourItem = { id: string; title: string; body: string; src: string; poster: string };

/** Accordion beside the matching recording. Each clip plays once, then the next item takes over until the visitor steps in. */
export function FeatureTour({ items, labels, width, height }: { items: readonly TourItem[]; labels: { play: string; pause: string }; width: number; height: number }) {
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  // Mirrors `active` synchronously so media events fired before React commits still see the right item.
  const activeRef = useRef(0);
  // Set once the visitor picks an item or pauses: from then on we follow their lead instead of auto-advancing.
  const engaged = useRef(false);
  const manuallyPaused = useRef(false);
  const reduce = useRef(false);

  const activate = useCallback((index: number) => {
    activeRef.current = index;
    setActive(index);
    videos.current.forEach((video, i) => {
      if (!video || i === index) return;
      video.pause();
      video.currentTime = 0;
    });
    videos.current[index]?.play().catch(() => {});
  }, []);

  useEffect(() => {
    reduce.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const node = stage.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        const video = videos.current[activeRef.current];
        if (!video) return;
        if (entry.isIntersecting && (!reduce.current || engaged.current) && !manuallyPaused.current) video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0.4 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const select = (index: number) => {
    engaged.current = true;
    manuallyPaused.current = false;
    activate(index);
  };

  const onEnded = (index: number) => {
    if (reduce.current || engaged.current) return;
    activate((index + 1) % items.length);
  };

  const onTimeUpdate = (index: number) => {
    const video = videos.current[index];
    const bar = bars.current[index];
    if (video && bar && video.duration) bar.style.transform = `scaleX(${video.currentTime / video.duration})`;
  };

  const toggle = () => {
    const video = videos.current[activeRef.current];
    if (!video) return;
    engaged.current = true;
    manuallyPaused.current = !video.paused;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };

  return (
    <div>
      <div ref={stage} className="relative overflow-hidden rounded-2xl bg-black ring-1 ring-white/20">
        {items.map((item, i) => (
          <video
            key={item.id}
            ref={(el) => void (videos.current[i] = el)}
            src={item.src}
            poster={item.poster}
            width={width}
            height={height}
            muted
            playsInline
            preload={i === 0 ? "metadata" : "none"}
            aria-label={item.title}
            aria-hidden={i !== active}
            tabIndex={-1}
            onEnded={() => onEnded(i)}
            onTimeUpdate={() => onTimeUpdate(i)}
            onPlay={() => i === activeRef.current && setPlaying(true)}
            onPause={() => i === activeRef.current && setPlaying(false)}
            className={`h-auto w-full transition-opacity duration-300 ${i === 0 ? "relative" : "absolute inset-0"} ${i === active ? "opacity-100" : "pointer-events-none opacity-0"}`}
          />
        ))}
        <PlayToggle playing={playing} onToggle={toggle} labels={labels} />
      </div>

      <ul className="mt-8 grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-6 md:grid-cols-3">
        {items.map((item, i) => {
          const open = i === active;
          return (
            <li key={item.id}>
              <span aria-hidden className="block h-0.5 bg-dark-line">
                <span ref={(el) => void (bars.current[i] = el)} className="block h-full origin-left bg-canvas [transform:scaleX(0)]" />
              </span>
              <h3 className="mt-4">
                <button
                  type="button"
                  aria-pressed={open}
                  onClick={() => select(i)}
                  className={`text-left text-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-canvas ${open ? "text-canvas" : "text-dark-muted hover:text-canvas"}`}
                >
                  {item.title}
                </button>
              </h3>
              <p className={`mt-2 leading-relaxed transition-colors ${open ? "text-dark-muted" : "text-dark-muted/70"}`}>{item.body}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
