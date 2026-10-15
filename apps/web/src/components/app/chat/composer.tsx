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
      className="flex items-end gap-2 border-t p-3"
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
        className="field-sizing-content max-h-48 min-h-10 flex-1 resize-none rounded-lg border border-input bg-input/30 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      {remaining < 200 && (
        <span id="composer-remaining" className="pb-2 text-xs text-muted-foreground">
          {remaining}
        </span>
      )}
      <Button type="submit" size="icon-lg" aria-label="Send message" disabled={!draft.trim()}>
        <SendHorizontalIcon />
      </Button>
    </form>
  );
}
