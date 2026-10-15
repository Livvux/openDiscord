"use client";

import { SendHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MESSAGE_MAX_LENGTH } from "@/lib/limits";

interface ComposerProps {
  channelName: string;
  draft: string;
  setDraft: (draft: string) => void;
  onSend: (content: string) => void;
}

export function Composer({ channelName, draft, setDraft, onSend }: ComposerProps) {
  function submit() {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    onSend(content);
  }

  const remaining = MESSAGE_MAX_LENGTH - draft.length;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="mx-4 mb-4 flex items-end gap-2 rounded-lg bg-white/5 py-1 pr-1 pl-4 ring-1 ring-white/10 focus-within:ring-2 focus-within:ring-ring"
    >
      <label htmlFor="composer" className="sr-only">
        Message #{channelName}
      </label>
      <textarea
        id="composer"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter adds a line; don't interrupt IME composition.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        maxLength={MESSAGE_MAX_LENGTH}
        placeholder={`Message #${channelName}`}
        aria-describedby={remaining < 200 ? "composer-remaining" : undefined}
        className="field-sizing-content max-h-48 min-h-10 flex-1 resize-none bg-transparent py-2 text-zinc-100 outline-none placeholder:text-zinc-400"
      />
      {remaining < 200 && (
        <span id="composer-remaining" className="pb-2.5 text-[11px] text-zinc-400">
          {remaining}
        </span>
      )}
      <Button type="submit" size="icon" aria-label="Send message" disabled={!draft.trim()} className="mb-1">
        <SendHorizontalIcon />
      </Button>
    </form>
  );
}
