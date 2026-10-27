"use client";

import { createContext, useContext, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { XIcon } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";

export type SettingsGroup = { label: string; sections: [id: string, label: string][] };

const ActiveSection = createContext("");

function subscribeHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function readHash() {
  try {
    return decodeURIComponent(window.location.hash.slice(1)).replace(/-heading$/, "");
  } catch {
    return "";
  }
}

export function SettingsModal({ title, closeHref, intercepted, groups, children }: {
  title: string;
  closeHref: string;
  intercepted: boolean;
  groups: SettingsGroup[];
  children: ReactNode;
}) {
  const router = useRouter();
  const contentRef = useRef<HTMLDivElement>(null);
  const hash = useSyncExternalStore(subscribeHash, readHash, () => "");
  const sections = groups.flatMap((group) => group.sections);
  const active = sections.find(([id]) => id === hash)?.[0] ?? sections[0][0];

  function selectSection(id: string) {
    // Null lets Next sync its canonical URL, so action refreshes don't add a history entry.
    window.history.replaceState(null, "", `#${encodeURIComponent(id)}-heading`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    contentRef.current?.scrollTo(0, 0);
  }

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open) {
        if (intercepted) router.back();
        else router.replace(closeHref);
      }
    }}>
      <DialogContent showCloseButton={false} aria-describedby={undefined} className="flex h-[min(800px,calc(100dvh-4rem))] w-[1100px] max-w-[calc(100%-1rem)] gap-0 overflow-hidden rounded-xl p-0 shadow-2xl max-md:h-[calc(100dvh-1rem)] sm:max-w-[calc(100%-4rem)]">
        <ActiveSection value={active}>
          <nav aria-label="Settings categories" className="w-60 shrink-0 overflow-y-auto border-r bg-panel px-3 pt-7 pb-8 max-sm:w-36 max-sm:px-2">
            <DialogTitle className="mb-7 px-2 text-sm font-semibold">{title}</DialogTitle>
            {groups.map((group) => (
              <div key={group.label} className="mb-5">
                <h2 className="truncate px-2 pb-2 text-xs font-bold tracking-wide text-muted-foreground uppercase" title={group.label}>{group.label}</h2>
                <ul className="space-y-0.5">
                  {group.sections.map(([id, label]) => (
                    <li key={id}>
                      <button type="button" aria-current={active === id ? "page" : undefined} onClick={() => selectSection(id)} className={`min-h-10 w-full rounded-md px-2.5 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring ${active === id ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"}`}>
                        {label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto overscroll-contain bg-background px-10 pt-16 pb-12 max-md:px-5 max-sm:px-3">
            {children}
          </div>
          <div className="absolute top-4 right-4 flex flex-col items-center gap-1">
            <DialogClose aria-label="Close settings" className="grid size-9 place-items-center rounded-full border-2 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              <XIcon className="size-5" />
            </DialogClose>
            <span aria-hidden className="text-[10px] font-semibold text-muted-foreground max-sm:hidden">ESC</span>
          </div>
        </ActiveSection>
      </DialogContent>
    </Dialog>
  );
}

export function SettingsSection({ id, title, description, children }: {
  id?: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const sectionId = id ?? title;
  const active = useContext(ActiveSection);
  const headingId = useId();
  return (
    <section hidden={active !== sectionId} aria-labelledby={headingId} className="space-y-6">
      <div className="space-y-2">
        <h2 id={headingId} className="text-xl font-semibold">{title}</h2>
        {description && <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}
