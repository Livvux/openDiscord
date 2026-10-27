"use client";

import { ChevronDownIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

const key = (id: string) => `opendiscord:category-collapsed:${id}`;
const listeners = new Set<() => void>();
function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Collapsible sidebar group; the collapsed state is remembered per browser. The open channel stays visible. */
export function CategoryGroup({ id, name, hrefs, children }: { id: string; name: string; hrefs: string[]; children: React.ReactNode[] }) {
  const collapsed = useSyncExternalStore(subscribe, () => localStorage.getItem(key(id)) === "1", () => false);
  const pathname = usePathname();
  const toggle = () => {
    if (collapsed) localStorage.removeItem(key(id));
    else localStorage.setItem(key(id), "1");
    listeners.forEach((l) => l());
  };
  return (
    <li>
      <h3>
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={toggle}
          className="flex w-full items-center gap-0.5 rounded px-2 pt-4 pb-1 text-left text-sm font-medium text-muted-foreground hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className="truncate">{name}</span>
          <ChevronDownIcon aria-hidden className={`size-3.5 shrink-0 transition-transform motion-reduce:transition-none ${collapsed ? "-rotate-90" : ""}`} />
        </button>
      </h3>
      <ul className="space-y-0.5">{children.filter((_, i) => !collapsed || hrefs[i] === pathname)}</ul>
    </li>
  );
}
