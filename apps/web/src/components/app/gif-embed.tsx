"use client";

import { useState } from "react";
import { gifSource } from "@/lib/gifs";

/** Externally hosted GIFs are opt-in: loading one exposes the viewer's IP to its provider. */
export function GifEmbed({ url }: { url: string }) {
  const source = gifSource(url);
  const [loaded, setLoaded] = useState(false);
  if (!source) return null;

  const brand = source === "giphy" ? "GIPHY" : "KLIPY";
  const home = source === "giphy" ? "https://giphy.com" : "https://klipy.com";
  const logo = source === "giphy" ? "/gif-providers/powered-by-giphy.png" : "/gif-providers/powered-by-klipy.svg";

  return (
    <div className="my-1 flex max-w-[28rem] flex-col items-start gap-2">
      {loaded ? (
        // External images must bypass the Next image optimizer; no server-side cache or proxy.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={"GIF from " + brand} width={400} height={300} loading="lazy" decoding="async"
          referrerPolicy="no-referrer" className="h-auto max-h-80 max-w-full rounded-lg bg-muted object-contain"
          onError={() => setLoaded(false)} />
      ) : (
        <button type="button" onClick={() => setLoaded(true)}
          className="rounded-lg border border-border bg-muted/60 px-4 py-3 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={"Load GIF from " + brand}>
          Load GIF from {brand}
          <span className="mt-1 block text-xs text-muted-foreground">External media: your IP address will be sent to {brand}.</span>
        </button>
      )}
      <a href={home} target="_blank" rel="noopener noreferrer nofollow"
        className="inline-flex items-center rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={"Powered by " + brand}>
        {/* Provider's official attribution mark, served locally. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} alt={"Powered by " + brand} height={16} className="h-4 w-auto" />
      </a>
    </div>
  );
}
