"use client";

import { Tooltip } from "@/components/ui/tooltip";
import { useMessages } from "@/lib/i18n/client";

/** Discord's verified seal: a blue rosette with a white check. */
export function VerifiedBadge({ className = "size-4", tooltip = true }: { className?: string; tooltip?: boolean }) {
  const label = useMessages().community.verified;
  const seal = (
    <span role="img" aria-label={label} className={`inline-grid shrink-0 place-items-center ${className}`}>
      <svg viewBox="0 0 16 16" className="size-full" aria-hidden>
        <path fill="#3b82f6" strokeLinejoin="round" stroke="#3b82f6" strokeWidth="1" d="M8 0.5L10.4 2.2L13.3 2.7L13.8 5.6L15.5 8L13.8 10.4L13.3 13.3L10.4 13.8L8 15.5L5.6 13.8L2.7 13.3L2.2 10.4L0.5 8L2.2 5.6L2.7 2.7L5.6 2.2Z" />
        <path fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M5 8.1l2 2 4-4.2" />
      </svg>
    </span>
  );
  return tooltip ? <Tooltip label={label}>{seal}</Tooltip> : seal;
}
