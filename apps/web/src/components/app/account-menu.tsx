"use client";

import { BanIcon, CheckIcon, CopyIcon, LogOutIcon, SettingsIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { setCustomStatus, setPresenceStatus } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { authClient } from "@/lib/auth-client";
import { PRESENCE_DOT, PRESENCE_LABEL, type PresenceChoice } from "@/lib/presence";
import { Avatar } from "./avatar";
import { useSetQuiet } from "./notifications-provider";

const CHOICES: PresenceChoice[] = ["online", "idle", "dnd", "invisible"];
const HINTS: Record<PresenceChoice, string> = {
  online: "Shown to your communities and friends",
  idle: "Shown as away",
  dnd: "Mutes desktop and push notifications",
  invisible: "Hidden; you appear offline",
};
const item = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-ring";

interface AccountMenuProps {
  userId: string;
  name: string;
  presence: PresenceChoice;
  customStatus: string;
}

/** Bottom of the rail: who you are, how you appear, and the way to settings and sign-out. */
export function AccountMenu({ userId, name, presence, customStatus }: AccountMenuProps) {
  const router = useRouter();
  const id = useId();
  const [choice, setChoice] = useState(presence);
  const [status, setStatus] = useState(customStatus);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const setQuiet = useSetQuiet();
  // Server renders (after refresh, or a change in settings) are authoritative again.
  const [rendered, setRendered] = useState({ presence, customStatus });
  if (rendered.presence !== presence || rendered.customStatus !== customStatus) {
    setRendered({ presence, customStatus });
    setChoice(presence);
    setStatus(customStatus);
  }
  const close = () => setOpen(false);
  useEffect(() => setQuiet?.(choice === "dnd"), [setQuiet, choice]);

  function choose(next: PresenceChoice) {
    const previous = choice;
    setChoice(next);
    startTransition(async () => {
      const result = await setPresenceStatus(next);
      if (!result.ok) setChoice(previous);
      setError(result.ok ? null : result.error);
    });
  }

  function saveStatus(text: string) {
    startTransition(async () => {
      const result = await setCustomStatus(text);
      if (result.ok) {
        setStatus(text.trim());
        if (field.current) field.current.value = text.trim();
      }
      setError(result.ok ? null : result.error);
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Account menu for ${name}, ${PRESENCE_LABEL[choice]}`}
        className="relative mb-4 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Avatar name={name} />
        <span aria-hidden className={`absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-sidebar ${PRESENCE_DOT[choice]}`} />
      </PopoverTrigger>
      <PopoverContent side="right" align="end" sideOffset={10} aria-label="Account menu" className="w-72 gap-1 p-2">
        <div className="flex items-center gap-3 px-2 pt-1 pb-2">
          <Avatar name={name} />
          <div className="min-w-0">
            <p className="truncate font-semibold text-zinc-50">{name}</p>
            <p className="truncate text-xs text-muted-foreground">{status || PRESENCE_LABEL[choice]}</p>
          </div>
        </div>

        <form
          className="px-2 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            saveStatus(String(new FormData(e.currentTarget).get("status") ?? ""));
          }}
        >
          <label htmlFor={`${id}-status`} className="sr-only">Custom status</label>
          <div className="flex gap-1">
            <Input id={`${id}-status`} ref={field} name="status" defaultValue={status} maxLength={80} placeholder="Set a custom status" className="h-7 text-xs" />
            {status && (
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Clear custom status" disabled={pending} onClick={() => { saveStatus(""); field.current?.focus(); }}>×</Button>
            )}
          </div>
        </form>

        <fieldset className="border-t border-white/5 px-1 pt-2 pb-1">
          <legend className="sr-only">Online status</legend>
          {CHOICES.map((c) => (
            <label key={c} className={`${item} relative cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring`}>
              <input type="radio" name={`${id}-presence`} value={c} checked={choice === c} onChange={() => choose(c)} className="sr-only" />
              <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${PRESENCE_DOT[c]}`} />
              <span className="min-w-0 flex-1">
                <span className="block">{PRESENCE_LABEL[c]}</span>
                <span className="block text-xs text-muted-foreground">{HINTS[c]}</span>
              </span>
              {choice === c && <CheckIcon aria-hidden className="size-4 text-brand-mint" />}
            </label>
          ))}
        </fieldset>
        {error && <p role="alert" className="px-2 text-xs text-destructive">{error}</p>}

        <div className="grid border-t border-white/5 pt-1">
          <Link href="/app/settings#Profile-heading" className={item} onClick={close}><UserIcon className="size-4" />Edit profile</Link>
          <Link href="/app/settings" className={item} onClick={close}><SettingsIcon className="size-4" />Account settings</Link>
          <Link href="/app/restrictions" className={item} onClick={close}><BanIcon className="size-4" />Community restrictions</Link>
          <button
            type="button"
            className={item}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(`${window.location.origin}/app/friends?add=${encodeURIComponent(userId)}`);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              } catch {
                setError("Couldn't copy. Your friend code is on the Friends page.");
              }
            }}
          >
            {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
            {copied ? "Friend link copied" : "Copy friend link"}
          </button>
          <button
            type="button"
            className={`${item} text-red-300`}
            onClick={async () => {
              const { error: failed } = await authClient.signOut();
              if (failed) return setError(failed.message ?? "Couldn't sign out. Try again.");
              close();
              router.push("/sign-in");
            }}
          >
            <LogOutIcon className="size-4" />Sign out
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
