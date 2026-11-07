"use client";

import { useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { useMessages } from "@/lib/i18n/client";

// The welcome page points the community step at this heading; a client module cannot export it to the server as a string.
const STEP_TITLE_ID = "onboarding-step-title";

interface OnboardingFlowProps {
  profile: React.ReactNode;
  appearance: React.ReactNode;
  invite: React.ReactNode;
  community: React.ReactNode;
}

/** Reached only from sign-up; Skip and Finish load Home as a fresh page, exactly where sign-up used to land. */
export function OnboardingFlow({ profile, appearance, invite, community }: OnboardingFlowProps) {
  const t = useMessages().onboarding;
  const [step, setStep] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const steps = [
    { title: t.profile, content: profile },
    { title: t.appearance, content: appearance },
    { title: t.invite, content: invite },
    { title: t.community, content: community },
  ];
  const last = step === steps.length - 1;

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
        <div className="ml-auto flex gap-2">
          {last ? homeLink(buttonVariants({ size: "lg" }), t.finish) : <>
            {homeLink(buttonVariants({ variant: "ghost" }), t.skip)}
            <Button size="lg" onClick={() => go(step + 1)}>{t.next}</Button>
          </>}
        </div>
      </div>
    </div>
  );
}

// A full page load on purpose: Home starts fresh, as right after sign-up, so DM device setup begins there cleanly.
// eslint-disable-next-line @next/next/no-html-link-for-pages
const homeLink = (className: string, label: string) => <a href="/app" className={className}>{label}</a>;
