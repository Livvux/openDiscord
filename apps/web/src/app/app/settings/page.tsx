import type { Metadata } from "next";
import { Suspense } from "react";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { BlockedList } from "@/components/app/settings/blocked-list";
import { DeleteAccount } from "@/components/app/settings/delete-account";
import { EmailSettings } from "@/components/app/settings/email-settings";
import { NotificationSettings } from "@/components/app/settings/notification-settings";
import { ProfileForm } from "@/components/app/settings/profile-form";
import { AvatarSettings } from "@/components/app/settings/avatar-settings";
import { ownAvatar } from "@/server/avatars";
import { mediaEnabled } from "@/server/media";
import { PasskeySettings } from "@/components/app/settings/passkey-settings";
import { Sessions } from "@/components/app/settings/sessions";
import { TwoFactorSettings } from "@/components/app/settings/two-factor-settings";
import { SignOutButton } from "@/app/app/sign-out-button";
import { ownedCommunityNames, twoFactorEnabled } from "@/server/account";
import { listBlocked } from "@/server/blocks";
import { presenceVisible } from "@/server/presence";
import { getProfile } from "@/server/profile";
import { pushEnabled, vapidPublicKey } from "@/server/push";
import { PushSettings } from "@/components/app/settings/push-settings";
import { PresenceSettings } from "@/components/app/settings/presence-settings";
import { requirePageUser } from "@/server/session";
import { mailEnabled } from "@/lib/mail";

export const metadata: Metadata = { title: "Account settings" };

export default function AccountSettingsPage() {
  return (
    <main className="flex-1 overflow-y-auto">
      <header className="flex h-12 items-center gap-2 border-b px-3">
        <MobileNavToggle />
        <h1 className="font-semibold">Account settings</h1>
      </header>
      <Suspense fallback={<p className="p-6 text-muted-foreground">Loading…</p>}>
        <Settings />
      </Suspense>
    </main>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${title}-heading`} className="space-y-3 border-b py-6 last:border-0">
      <div>
        <h2 id={`${title}-heading`} className="text-lg font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

async function Settings() {
  const user = await requirePageUser();
  const [owned, has2fa, blocked, showPresence, profile, avatar] = await Promise.all([
    ownedCommunityNames(user.id),
    twoFactorEnabled(user.id),
    listBlocked(user.id),
    presenceVisible(user.id),
    getProfile(user.id),
    ownAvatar(user.id),
  ]);
  return (
    <div className="mx-auto max-w-2xl px-6">
      <Section title="Profile" description="Your display name is visible to members of communities you join; your status and bio to your friends. Your email address is not.">
        {mediaEnabled && <AvatarSettings name={user.name} avatar={avatar} />}
        <ProfileForm name={user.name} email={user.email} bio={profile.bio} customStatus={profile.customStatus} />
      </Section>
      <Section title="Email address" description="Changes require a recent sign-in and verification. Your email is never shown to other members.">
        {mailEnabled ? <EmailSettings email={user.email} /> : <p className="text-sm text-muted-foreground">Email changes are unavailable because this instance has not configured email delivery.</p>}
      </Section>
      <Section title="Notifications" description="Mentions always show a badge in the app. Desktop notifications are optional.">
        <NotificationSettings />
        {pushEnabled && vapidPublicKey && <PushSettings publicKey={vapidPublicKey} />}
      </Section>
      <Section title="Online status" description="Off by default. When on, members of your communities and your friends see a dot while you have openDiscord open. Choose Idle or Do not disturb from the account menu.">
        <PresenceSettings visible={showPresence} />
      </Section>
      <Section title="Blocked people" description="Their messages are collapsed for you and their mentions don't notify you. They aren't told.">
        <BlockedList blocked={blocked} currentUserId={user.id} />
      </Section>
      <Section title="Authenticator app" description="Optional two-factor authentication with a time-based code (TOTP).">
        <TwoFactorSettings enabled={has2fa} />
      </Section>
      <Section title="Passkeys" description="Sign in with Face ID, Touch ID, Windows Hello or a security key.">
        <PasskeySettings />
      </Section>
      <Section title="Sessions" description="Devices currently signed in to your account.">
        <Sessions />
        <SignOutButton userId={user.id} />
      </Section>
      <Section title="Your data" description="Download your profile, sessions, security settings, memberships and messages as JSON.">
        <a
          href="/api/me/export"
          download
          className="inline-flex h-8 items-center rounded-lg border px-3 text-sm font-medium hover:bg-muted"
        >
          Download my data
        </a>
      </Section>
      <Section title="Delete account" description="Permanently deletes your account, your sessions and every message you wrote. This can't be undone.">
        <DeleteAccount ownedCommunities={owned} />
      </Section>
    </div>
  );
}
