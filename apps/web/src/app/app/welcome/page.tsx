import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { GettingStarted } from "@/components/app/home/getting-started";
import { InviteFriends } from "@/components/app/onboarding/invite-friends";
import { OnboardingFlow } from "@/components/app/onboarding/onboarding-flow";
import { AvatarSettings } from "@/components/app/settings/avatar-settings";
import { LanguageSettings } from "@/components/app/settings/language-settings";
import { ProfileForm } from "@/components/app/settings/profile-form";
import { ThemeSettings } from "@/components/app/settings/theme-settings";
import { DiamondOrbitSmoothLoader } from "@/components/ui/diamond-orbit-smooth-loader";
import { ownAvatar } from "@/server/avatars";
import { mediaEnabled } from "@/server/media";
import { getProfile, needsOnboarding } from "@/server/profile";
import { listPublicChannels } from "@/server/public-channels";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Welcome" };

export default function WelcomePage({ searchParams }: PageProps<"/app/welcome">) {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Suspense fallback={<div className="m-auto text-primary"><DiamondOrbitSmoothLoader /></div>}>
        <Welcome searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Welcome({ searchParams }: Pick<PageProps<"/app/welcome">, "searchParams">) {
  const user = await requirePageUser();
  const [{ add }, onboarding, profile, avatar, { channels }] = await Promise.all([
    searchParams, needsOnboarding(user.id), getProfile(user.id), ownAvatar(user.id), listPublicChannels(),
  ]);
  const next = typeof add === "string" && add.length <= 64 ? `/app?add=${encodeURIComponent(add)}` : "/app";
  if (!onboarding) redirect(next);
  return (
    <OnboardingFlow
      next={next}
      profile={<>
        {mediaEnabled && <AvatarSettings name={user.name} avatar={avatar} />}
        <ProfileForm name={user.name} email={user.email} bio={profile.bio} customStatus={profile.customStatus} />
      </>}
      appearance={<><ThemeSettings /><LanguageSettings /></>}
      invite={<InviteFriends userId={user.id} />}
      community={<GettingStarted hasPublicChannels={channels.length > 0} labelledBy="onboarding-step-title" />}
    />
  );
}
