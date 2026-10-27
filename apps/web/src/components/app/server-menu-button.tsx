"use client";

import { ChevronDownIcon } from "lucide-react";
import { openContextMenuFrom } from "@/components/ui/context-menu";

/** The server name opens the same actions as a right-click, like Discord's header dropdown. */
export function ServerMenuButton({ name }: { name: string }) {
  return (
    <button
      type="button"
      aria-haspopup="menu"
      onClick={(e) => openContextMenuFrom(e.currentTarget)}
      className="flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-left text-base font-semibold text-sidebar-foreground hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="truncate">{name}</span>
      <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
    </button>
  );
}
