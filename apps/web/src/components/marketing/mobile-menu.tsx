"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Menu } from "lucide-react";

type Item = { label: string; href: string; internal?: boolean };

/** Disclosure menu for small screens; closes on selection, Escape and outside clicks. */
export function MobileMenu({ label, items }: { label: string; items: readonly Item[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = () => ref.current?.removeAttribute("open");
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onPointer = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, []);
  const itemClass = "block rounded-lg px-3 py-2 text-[15px] transition-colors hover:bg-ink/5";
  return (
    <details ref={ref} className="relative md:hidden">
      <summary aria-label={label} className="grid size-9 cursor-pointer list-none place-items-center rounded-lg transition-colors hover:bg-ink/5 [&::-webkit-details-marker]:hidden">
        <Menu aria-hidden className="size-5" />
      </summary>
      <ul className="absolute right-0 mt-2 w-48 rounded-2xl border border-line bg-white p-1.5 shadow-lg shadow-ink/10" onClick={() => ref.current?.removeAttribute("open")}>
        {items.map((item) => (
          <li key={item.href}>
            {item.internal ? (
              <Link href={item.href} className={itemClass}>
                {item.label}
              </Link>
            ) : (
              <a href={item.href} className={itemClass}>
                {item.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
