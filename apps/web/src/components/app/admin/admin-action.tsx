"use client";

import { EllipsisIcon } from "lucide-react";
import { useId, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/server/errors";

type Variant = "outline" | "destructive" | "default" | "ghost" | "secondary";

export interface AdminActionProps {
  label: string;
  description: string;
  action: (reason: string, extra: string) => Promise<ActionResult<unknown>>;
  extraLabel?: string;
  extraType?: "text" | "email";
  variant?: Variant;
  icon?: React.ReactNode;
}

/** Audited admin action: asks for a reason, which is stored in the instance audit log. */
export function AdminAction(props: AdminActionProps) {
  const [open, setOpen] = useState(false);
  return (
    <AdminActionDialog {...props} open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={props.variant ?? "outline"} size="sm" />}>{props.icon}{props.label}</DialogTrigger>
    </AdminActionDialog>
  );
}

function AdminActionDialog({ label, description, action, extraLabel, extraType = "text", variant = "outline", open, onOpenChange, children }: AdminActionProps & { open: boolean; onOpenChange: (open: boolean) => void; children?: React.ReactNode }) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); setError(null); }}>
      {children}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>{description} This action and your reason are recorded in the instance audit log.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            startTransition(async () => {
              const result = await action(String(data.get("reason")), String(data.get("extra") ?? ""));
              if (result.ok) onOpenChange(false);
              else setError(result.error);
            });
          }}
        >
          {extraLabel && (
            <>
              <Label htmlFor={`${id}-extra`}>{extraLabel}</Label>
              <Input id={`${id}-extra`} name="extra" type={extraType} required maxLength={254} />
            </>
          )}
          <Label htmlFor={`${id}-reason`}>Reason</Label>
          <Textarea id={`${id}-reason`} name="reason" required minLength={3} maxLength={512} />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" variant={variant === "destructive" ? "destructive" : "default"} disabled={pending}>
              Confirm {label.toLowerCase()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Less frequent audited actions behind one button, so each row shows only its main decisions. */
export function MoreActions({ label, items }: { label: string; items: AdminActionProps[] }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [active, setActive] = useState<AdminActionProps | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger render={<Button ref={trigger} variant="outline" size="sm" aria-label={label} />}><EllipsisIcon />More</PopoverTrigger>
        <PopoverContent align="end" className="w-56 gap-0.5 p-1">
          {items.map((item) => (
            <Button
              key={item.label}
              variant="ghost"
              size="sm"
              className={`justify-start ${item.variant === "destructive" ? "text-destructive" : ""}`}
              onClick={() => { setMenuOpen(false); setActive(item); }}
            >
              {item.label}
            </Button>
          ))}
        </PopoverContent>
      </Popover>
      {active && (
        <AdminActionDialog
          {...active}
          open
          onOpenChange={(open) => { if (!open) { setActive(null); trigger.current?.focus(); } }}
        />
      )}
    </>
  );
}

/** One-click action with inline error, for frequent low-risk decisions (still audited server-side). */
export function QuickAction({ label, action, icon, variant = "default" }: { label: string; action: () => Promise<ActionResult<unknown>>; icon?: React.ReactNode; variant?: Variant }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant={variant}
        disabled={pending}
        onClick={() => startTransition(async () => {
          const result = await action();
          setError(result.ok ? null : result.error);
        })}
      >
        {icon}{pending ? "Working…" : label}
      </Button>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
