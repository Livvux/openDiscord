"use client";

import { useState, useTransition } from "react";
import { setOnboardingOptions } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SELF_ASSIGNABLE } from "@/server/permissions";
import type { RoleSummary } from "@/server/moderation";
import type { OnboardingOptionView } from "@/server/onboarding";

/** Which roles new members may pick, each with the label they see. */
export function OnboardingEditor({ communityId, roles, options }: { communityId: string; roles: RoleSummary[]; options: OnboardingOptionView[] }) {
  const candidates = roles.filter((r) => !r.isDefault && (r.permissions & ~SELF_ASSIGNABLE) === 0);
  const [offered, setOffered] = useState(() => new Map(options.map((o) => [o.roleId, o.label])));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  if (!candidates.length) return <p className="text-sm text-muted-foreground">Create a role with only channel access (no moderation permissions) to offer it here.</p>;
  const update = (roleId: string, label: string | null) => {
    setSaved(false);
    setOffered((map) => { const next = new Map(map); if (label === null) next.delete(roleId); else next.set(roleId, label); return next; });
  };
  return (
    <form
      className="grid max-w-xl gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const list = candidates.filter((r) => offered.has(r.id)).map((r) => ({ roleId: r.id, label: offered.get(r.id)! }));
          const result = await setOnboardingOptions(communityId, list);
          setError(result.ok ? null : result.error);
          setSaved(result.ok);
        });
      }}
    >
      <ul className="divide-y rounded-lg border">
        {candidates.map((r) => (
          <li key={r.id} className="flex items-center gap-3 px-3 py-2">
            <label className="flex w-40 shrink-0 items-center gap-2 text-sm">
              <input type="checkbox" checked={offered.has(r.id)} onChange={(e) => update(r.id, e.target.checked ? r.name : null)} />
              {r.name}
            </label>
            {offered.has(r.id) && (
              <Input aria-label={`Label for ${r.name}`} value={offered.get(r.id)} maxLength={48} required onChange={(e) => update(r.id, e.target.value)} />
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>Save onboarding</Button>
        {saved && <p role="status" className="text-sm text-muted-foreground">Saved.</p>}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
