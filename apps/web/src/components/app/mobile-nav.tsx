"use client";

import { MenuIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

// Below the md breakpoint the community rail and channel list become an off-canvas panel.
const MobileNavContext = createContext<{ open: boolean; setOpen: (open: boolean) => void }>({
  open: false,
  setOpen: () => {},
});

export function MobileNavProvider({ children }: { children: React.ReactNode }) {
  // Open only on the page where it was opened: any navigation (e.g. creating a community) closes it.
  const pathname = usePathname();
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === pathname;
  const setOpen = useCallback((value: boolean) => setOpenedAt(value ? pathname : null), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  return (
    <MobileNavContext.Provider value={{ open, setOpen }}>
      {children}
      {open && (
        <div aria-hidden className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setOpen(false)} />
      )}
    </MobileNavContext.Provider>
  );
}

/** Wraps a sidebar: always visible from md up, an overlay panel below when opened. */
export function MobilePanel({ className, children, label }: { className: string; children: React.ReactNode; label: string }) {
  const { open, setOpen } = useContext(MobileNavContext);
  return (
    <nav
      aria-label={label}
      // Close the overlay once a link inside it is followed.
      onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}
      className={`${className} ${open ? "max-md:fixed max-md:inset-y-0 max-md:z-40 max-md:flex" : "max-md:hidden"}`}
    >
      {children}
    </nav>
  );
}

export function MobileNavToggle() {
  const { open, setOpen } = useContext(MobileNavContext);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="md:hidden"
      aria-label="Open navigation"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      <MenuIcon />
    </Button>
  );
}
