"use client";

import { MenuIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { createContext, Suspense, useContext, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

// Below the md breakpoint the community rail and channel list become an off-canvas panel.
const MobileNavContext = createContext<{ open: boolean; setOpen: (open: boolean) => void }>({
  open: false,
  setOpen: () => {},
});

export function MobileNavProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <MobileNavContext.Provider value={{ open, setOpen }}>
      <Suspense><CloseOnNavigation close={() => setOpen(false)} /></Suspense>
      {children}
      {open && (
        <div aria-hidden className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setOpen(false)} />
      )}
    </MobileNavContext.Provider>
  );
}

/** Any navigation (e.g. creating a community) closes the overlay, not only links inside it. */
function CloseOnNavigation({ close }: { close: () => void }) {
  const pathname = usePathname();
  const latest = useRef(close);
  useEffect(() => { latest.current = close; });
  useEffect(() => { latest.current(); }, [pathname]);
  return null;
}

/** Wraps a sidebar: always visible from md up, an overlay panel below when opened. */
export function MobilePanel({ className, children, label }: { className: string; children: React.ReactNode; label: string }) {
  const { open, setOpen } = useContext(MobileNavContext);
  return (
    <nav
      aria-label={label}
      // Close the overlay once a link inside it is followed.
      onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}
      className={`${className} ${open ? "max-md:fixed max-md:inset-y-0 max-md:z-40 max-md:flex max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]" : "max-md:hidden"}`}
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
