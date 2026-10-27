"use client";

import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "cn";

const itemClassName = "relative flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0";

function ContextMenu(props: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root {...props} />;
}

function needsNativeMenu(event: React.SyntheticEvent<HTMLElement>) {
  const target = event.target;
  return !(target instanceof Node) || !event.currentTarget.contains(target)
    || (target instanceof Element && !!target.closest("input, textarea, select, [contenteditable]"));
}

/** Opens the enclosing context menu from an ordinary button, below it (Discord's server "⌄" and message "…"). */
export function openContextMenuFrom(button: HTMLElement) {
  const rect = button.getBoundingClientRect();
  button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom + 4 }));
}

function ContextMenuTrigger({ onKeyDown, onContextMenuCapture, onTouchStartCapture, onTouchEnd, tabIndex = 0, ...props }: ContextMenuPrimitive.Trigger.Props) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      tabIndex={tabIndex}
      {...props}
      onContextMenuCapture={(event) => {
        // Portals still bubble through their React parents. Stop before the menu
        // primitive (and its document listener) can consume a dialog or text field.
        if (needsNativeMenu(event)) { event.stopPropagation(); return; }
        onContextMenuCapture?.(event);
      }}
      onTouchStartCapture={(event) => {
        if (needsNativeMenu(event)) { event.stopPropagation(); return; }
        onTouchStartCapture?.(event);
      }}
      onTouchEnd={(event) => {
        // Lifting the opening long press must not click the item that appeared
        // under the finger. Subsequent taps inside the portalled menu still work.
        if (!needsNativeMenu(event) && event.currentTarget.hasAttribute("data-popup-open")) event.preventDefault();
        onTouchEnd?.(event);
      }}
      onKeyDown={(event) => {
        if (needsNativeMenu(event)) return;
        onKeyDown?.(event);
        if (event.defaultPrevented || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
        // Text fields retain their native editing menu. A nested user target handles
        // its own shortcut before an enclosing message target sees the event.
        event.preventDefault();
        event.stopPropagation();
        const target = event.currentTarget;
        const rect = target.getBoundingClientRect();
        target.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + Math.min(16, rect.width / 2),
          clientY: rect.top + Math.min(24, rect.height / 2),
        }));
      }}
    />
  );
}

function ContextMenuContent({
  className, side, sideOffset, align, alignOffset, ...props
}: ContextMenuPrimitive.Popup.Props & Pick<ContextMenuPrimitive.Positioner.Props, "side" | "sideOffset" | "align" | "alignOffset">) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} alignOffset={alignOffset} collisionPadding={8} className="isolate z-50">
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn("max-h-[var(--available-height)] min-w-52 max-w-[calc(100vw-1rem)] origin-(--transform-origin) overflow-y-auto rounded-lg bg-popover p-1.5 text-popover-foreground shadow-xl ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none", className)}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({ className, variant, ...props }: ContextMenuPrimitive.Item.Props & { variant?: "default" | "destructive" }) {
  return <ContextMenuPrimitive.Item data-slot="context-menu-item" className={cn(itemClassName, variant === "destructive" && "text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive", className)} {...props} />;
}

function ContextMenuLinkItem({ className, closeOnClick = true, ...props }: ContextMenuPrimitive.LinkItem.Props) {
  return <ContextMenuPrimitive.LinkItem data-slot="context-menu-link-item" className={cn(itemClassName, className)} closeOnClick={closeOnClick} {...props} />;
}

function ContextMenuSeparator({ className, ...props }: ContextMenuPrimitive.Separator.Props) {
  return <ContextMenuPrimitive.Separator data-slot="context-menu-separator" className={cn("my-1 h-px bg-border", className)} {...props} />;
}

function ContextMenuLabel({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="context-menu-label" className={cn("max-w-64 truncate px-2 py-1.5 text-xs font-semibold text-muted-foreground", className)} {...props} />;
}

function ContextMenuSubTrigger({ className, children, ...props }: ContextMenuPrimitive.SubmenuTrigger.Props) {
  return <ContextMenuPrimitive.SubmenuTrigger className={cn(itemClassName, className)} {...props}>{children}<ChevronRightIcon className="ml-auto" aria-hidden /></ContextMenuPrimitive.SubmenuTrigger>;
}

function ContextMenuRadioItem({ className, children, ...props }: ContextMenuPrimitive.RadioItem.Props) {
  return <ContextMenuPrimitive.RadioItem className={cn(itemClassName, "pr-8", className)} {...props}>{children}<ContextMenuPrimitive.RadioItemIndicator className="absolute right-2"><CheckIcon aria-hidden /></ContextMenuPrimitive.RadioItemIndicator></ContextMenuPrimitive.RadioItem>;
}

function ContextMenuCheckboxItem({ className, children, ...props }: ContextMenuPrimitive.CheckboxItem.Props) {
  return <ContextMenuPrimitive.CheckboxItem className={cn(itemClassName, "pr-8", className)} {...props}>{children}<ContextMenuPrimitive.CheckboxItemIndicator className="absolute right-2"><CheckIcon aria-hidden /></ContextMenuPrimitive.CheckboxItemIndicator></ContextMenuPrimitive.CheckboxItem>;
}

const ContextMenuGroup = ContextMenuPrimitive.Group;
const ContextMenuSub = ContextMenuPrimitive.SubmenuRoot;
const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

export {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLinkItem,
  ContextMenuSeparator, ContextMenuLabel, ContextMenuGroup, ContextMenuSub, ContextMenuSubTrigger,
  ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuCheckboxItem,
};
