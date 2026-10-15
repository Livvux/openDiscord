"use client";

import { useState, useTransition } from "react";
import { createIntegration, revokeIntegration } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { IntegrationSummary } from "@/server/integrations";

interface IntegrationsEditorProps {
  communityId: string;
  integrations: IntegrationSummary[];
  textChannels: { id: string; name: string }[];
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const selectClass = "h-8 rounded-lg bg-white/5 px-2 text-sm ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

export function IntegrationsEditor({ communityId, integrations, textChannels }: IntegrationsEditorProps) {
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const channelName = (id: string | null) => textChannels.find((c) => c.id === id)?.name ?? "a deleted channel";

  function create(input: Parameters<typeof createIntegration>[1], form: HTMLFormElement) {
    startTransition(async () => {
      const result = await createIntegration(communityId, input);
      if (!result.ok) return setError(result.error);
      setError(null);
      form.reset();
      setSecret(
        input.kind === "webhook"
          ? { label: "Webhook URL", value: `${window.location.origin}/api/webhooks/${result.data.id}/${result.data.token}` }
          : { label: "Bot token", value: result.data.token },
      );
    });
  }

  return (
    <div className="grid max-w-xl gap-4">
      {secret && (
        <div role="status" className="grid gap-1.5 rounded-lg border border-amber-400/40 bg-amber-400/10 p-3">
          <Label htmlFor="integration-secret">{secret.label} — shown only once</Label>
          <div className="flex gap-2">
            <Input id="integration-secret" readOnly value={secret.value} onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(secret.value)}>Copy</Button>
          </div>
          <p className="text-xs text-muted-foreground">Store it somewhere safe. Anyone with it can post as this integration. Revoke it if it leaks.</p>
        </div>
      )}
      {integrations.length > 0 && (
        <ul className="divide-y rounded-lg border text-sm">
          {integrations.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
              <span className="rounded bg-white/10 px-1.5 text-[10px] font-semibold uppercase">{i.kind}</span>
              <span className="font-medium">{i.name}</span>
              {i.kind === "webhook" && <span className="text-muted-foreground">→ #{channelName(i.channelId)}</span>}
              <span className="ml-auto text-xs text-muted-foreground" suppressHydrationWarning>
                {i.lastUsedAt ? `used ${dateFormat.format(i.lastUsedAt)}` : "never used"}
              </span>
              <Button
                variant="destructive"
                size="sm"
                disabled={pending}
                aria-label={`Revoke ${i.kind} ${i.name}`}
                onClick={() =>
                  window.confirm(`Revoke ${i.name}? Its token stops working immediately.`) &&
                  startTransition(async () => {
                    const result = await revokeIntegration(i.id);
                    setError(result.ok ? null : result.error);
                  })
                }
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create({ kind: "bot", name: String(new FormData(e.currentTarget).get("name")) }, e.currentTarget);
        }}
        className="grid gap-1.5"
      >
        <Label htmlFor="new-bot">New bot</Label>
        <div className="flex gap-2">
          <Input id="new-bot" name="name" maxLength={32} required placeholder="e.g. Release notes" />
          <Button type="submit" disabled={pending}>Create bot</Button>
        </div>
        <p className="text-xs text-muted-foreground">Joins as a member with the default role. Give it roles in Members. It uses the <a className="underline" href="/api/v1/openapi.json">public API</a>.</p>
      </form>
      {textChannels.length > 0 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            create({ kind: "webhook", name: String(data.get("name")), channelId: String(data.get("channelId")) }, e.currentTarget);
          }}
          className="grid gap-1.5"
        >
          <Label htmlFor="new-webhook">New webhook</Label>
          <div className="flex flex-wrap gap-2">
            <Input id="new-webhook" name="name" maxLength={32} required placeholder="e.g. CI" className="min-w-40 flex-1" />
            <label htmlFor="new-webhook-channel" className="sr-only">Webhook channel</label>
            <select id="new-webhook-channel" name="channelId" className={selectClass} required>
              {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </select>
            <Button type="submit" disabled={pending}>Create webhook</Button>
          </div>
          <p className="text-xs text-muted-foreground">Other services post plain messages into one channel with <code>POST {"{"}&quot;content&quot;: &quot;…&quot;{"}"}</code>.</p>
        </form>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
