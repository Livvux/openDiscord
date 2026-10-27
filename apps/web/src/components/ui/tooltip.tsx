"use client"

import type { ReactElement, ReactNode } from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cn } from "cn"

interface TooltipProps {
  label: ReactNode
  /** The element that shows the tooltip on hover and keyboard focus. */
  children: ReactElement
  side?: "top" | "right" | "bottom" | "left"
  delay?: number
  className?: string
}

/** Discord's tooltip: a dark bubble with an arrow, bold label. */
function Tooltip({ label, children, side = "top", delay = 150, className }: TooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger delay={delay} closeDelay={0} render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={side === "right" ? 14 : 8} className="isolate z-50">
          <TooltipPrimitive.Popup
            className={cn(
              "max-w-72 origin-(--transform-origin) rounded-md bg-[#111214] px-3 py-1.5 text-sm font-semibold text-white shadow-lg ring-1 ring-white/5 duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 motion-reduce:animate-none",
              className
            )}
          >
            <TooltipPrimitive.Arrow className="size-2.5 rotate-45 bg-[#111214] data-[side=bottom]:-top-1 data-[side=left]:-right-1 data-[side=right]:-left-1 data-[side=top]:-bottom-1" />
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export { Tooltip }
