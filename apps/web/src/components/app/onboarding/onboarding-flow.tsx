"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { completeOnboarding } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/lib/i18n/client";

// The welcome page points the community step at this heading; a client module cannot export it to the server as a string.
const STEP_TITLE_ID = "onboarding-step-title";

interface OnboardingFlowProps {
  profile: React.ReactNode;
  appearance: React.ReactNode;
  invite: React.ReactNode;
  community: React.ReactNode;
  /** Where Home continues afterwards, keeping a friend link (?add=) that brought the person here. */
  next: string;
}

export function OnboardingFlow({ profile, appearance, invite, community, next }: OnboardingFlowProps) {
  const t = useMessages().onboarding;
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [leaving, startLeaving] = useTransition();
  const done = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const steps = [
    { title: t.profile, content: profile },
    { title: t.appearance, content: appearance },
    { title: t.invite, content: invite },
    { title: t.community, content: community },
  ];
  const last = step === steps.length - 1;

  // Reaching the last step counts as finished: joining or creating a community there leaves this page.
  useEffect(() => {
    if (last && !done.current) {
      done.current = true;
      void completeOnboarding();
    }
  }, [last]);

  function go(to: number) {
    setStep(to);
    requestAnimationFrame(() => heading.current?.focus());
  }

  function leave() {
    startLeaving(async () => {
      if (!done.current) {
        done.current = true;
        await completeOnboarding();
      }
      router.replace(next);
    });
  }

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-6 p-4 md:p-8">
      <ol aria-label={t.steps} className="grid grid-cols-4 gap-2">
        {steps.map((s, i) => (
          <li key={s.title} aria-current={i === step ? "step" : undefined} className={`h-1.5 rounded-full ${i <= step ? "bg-primary" : "bg-muted"}`}>
            <span className="sr-only">{s.title}</span>
          </li>
        ))}
      </ol>
      <section aria-labelledby={STEP_TITLE_ID} className="grid gap-5">
        <h1 id={STEP_TITLE_ID} ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">{steps[step].title}</h1>
        {/* All steps stay mounted so going back keeps unsaved input. */}
        {steps.map((s, i) => <div key={s.title} hidden={i !== step} className="grid gap-5">{s.content}</div>)}
      </section>
      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        {step > 0 && <Button variant="ghost" onClick={() => go(step - 1)} disabled={leaving}>{t.back}</Button>}
        <div className="ml-auto flex gap-2">
          {!last && <Button variant="ghost" onClick={leave} disabled={leaving}>{t.skip}</Button>}
          <Button size="lg" onClick={last ? leave : () => go(step + 1)} disabled={leaving}>{last ? t.finish : t.next}</Button>
        </div>
      </div>
    </div>
  );
}
