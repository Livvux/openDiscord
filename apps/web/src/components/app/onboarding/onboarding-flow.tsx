"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { completeOnboarding, finishOnboarding } from "@/app/app/actions";
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
  const [step, setStep] = useState(0);
  const done = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
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
    // Save edits the person made but did not submit (the profile form) instead of dropping them.
    const form = body.current?.querySelector<HTMLFormElement>(`[data-step="${step}"] form`);
    const dirty = form && Array.from(form.elements).some((el) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.type !== "hidden" && el.value !== el.defaultValue);
    if (dirty) form.requestSubmit();
    setStep(to);
    requestAnimationFrame(() => heading.current?.focus());
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
      <section ref={body} aria-labelledby={STEP_TITLE_ID} className="grid gap-5">
        <h1 id={STEP_TITLE_ID} ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">{steps[step].title}</h1>
        {/* All steps stay mounted so going back keeps unsaved input. */}
        {steps.map((s, i) => <div key={s.title} data-step={i} hidden={i !== step} className="grid gap-5">{s.content}</div>)}
      </section>
      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        {step > 0 && <Button variant="ghost" onClick={() => go(step - 1)}>{t.back}</Button>}
        <form action={finishOnboarding} className="ml-auto flex gap-2">
          <input type="hidden" name="next" value={next} />
          {last ? <Leave size="lg">{t.finish}</Leave> : <>
            <Leave variant="ghost">{t.skip}</Leave>
            <Button size="lg" type="button" onClick={() => go(step + 1)}>{t.next}</Button>
          </>}
        </form>
      </div>
    </div>
  );
}

function Leave(props: React.ComponentProps<typeof Button>) {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending} {...props} />;
}
