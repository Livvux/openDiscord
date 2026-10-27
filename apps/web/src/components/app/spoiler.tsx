"use client";

import { useState } from "react";

/** Discord's `||spoiler||`: hidden behind a dark bar until clicked. */
export function Spoiler({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  if (shown) return <span data-spoiler className="rounded-[3px] bg-white/10 px-0.5">{children}</span>;
  return (
    <button type="button" data-spoiler aria-label="Spoiler, select to reveal" onClick={(e) => { e.stopPropagation(); setShown(true); }}
      className="cursor-pointer rounded-[3px] bg-[#1e1f22] px-0.5 text-transparent select-none hover:bg-[#26272b] [&_*]:invisible">
      {children}
    </button>
  );
}
