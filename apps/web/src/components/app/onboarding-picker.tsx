"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { chooseOnboarding } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import type { OnboardingOptionView } from "@/server/onboarding";

/** Shown once after joining (and again on request): members pick roles, which can unlock channels. */
export function OnboardingPicker({ communityId, communityName, options }: { communityId: string; communityName: string; options: OnboardingOptionView[] }) {
  const router = useRouter();
  const [picked, setPicked] = useState(() => new Set(options.filter((o) => o.selected).map((o) => o.id)));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const submit = (ids: string[]) => startTransition(async () => {
    const result = await chooseOnboarding(communityId, ids);
    if (!result.ok) return setError(result.error);
    router.refresh();
  });
  return (
    <section aria-labelledby="onboarding-heading" className="shrink-0 border-b p-4">
      <h2 id="onboarding-heading" className="mb-3 font-semibold">What brings you to {communityName}?</h2>
      <fieldset className="mb-3 flex flex-wrap gap-2" disabled={pending}>
        <legend className="sr-only">Pick roles</legend>
        {options.map((o) => (
          <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm has-checked:border-primary has-checked:bg-primary/10">
            <input
              type="checkbox"
              checked={picked.has(o.id)}
              onChange={(e) => setPicked((set) => { const next = new Set(set); if (e.target.checked) next.add(o.id); else next.delete(o.id); return next; })}
            />
            {o.label}
          </label>
        ))}
      </fieldset>
      <div className="flex gap-2">
        <Button disabled={pending} onClick={() => submit([...picked])}>Save</Button>
        <Button variant="ghost" disabled={pending} onClick={() => submit([])}>Skip</Button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </section>
  );
}
