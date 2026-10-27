import { Suspense } from "react";
import { SettingsModal, SettingsSection as Section } from "@/components/app/settings/settings-modal";
import { BlockedList } from "@/components/app/settings/blocked-list";
import { DeleteAccount } from "@/components/app/settings/delete-account";
import { EmailSettings } from "@/components/app/settings/email-settings";
import { NotificationSettings } from "@/components/app/settings/notification-settings";
import { ProfileForm } from "@/components/app/settings/profile-form";
import { AvatarSettings } from "@/components/app/settings/avatar-settings";
import { ownAvatar } from "@/server/avatars";
import { mediaEnabled } from "@/server/media";
import { PasskeySettings } from "@/components/app/settings/passkey-settings";
import { ThemeSettings } from "@/components/app/settings/theme-settings";
import { Sessions } from "@/components/app/settings/sessions";
import { TwoFactorSettings } from "@/components/app/settings/two-factor-settings";
import { SignOutButton } from "@/app/app/sign-out-button";
import { BadgeOverview } from "@/components/app/badges";
import { ownedCommunityNames, twoFactorEnabled } from "@/server/account";
import { badgesOf } from "@/server/badges";
import { listBlocked } from "@/server/blocks";
import { presenceVisible } from "@/server/presence";
import { getProfile } from "@/server/profile";
import { pushEnabled, vapidPublicKey } from "@/server/push";
import { PushSettings } from "@/components/app/settings/push-settings";
import { PresenceSettings } from "@/components/app/settings/presence-settings";
import { requirePageUser } from "@/server/session";
import { mailEnabled } from "@/lib/mail";
import { DiamondOrbitSmoothLoader } from "@/components/ui/diamond-orbit-smooth-loader";

export function AccountSettings({ intercepted = false }: { intercepted?: boolean }) {
  return (
    <Suspense fallback={<div className="p-6 text-primary"><DiamondOrbitSmoothLoader /></div>}>
      <Settings intercepted={intercepted} />
    </Suspense>
  );
}

async function Settings({ intercepted }: { intercepted: boolean }) {
  const user = await requirePageUser();
  const [owned, has2fa, blocked, showPresence, profile, avatar, badges] = await Promise.all([
    ownedCommunityNames(user.id),
    twoFactorEnabled(user.id),
    listBlocked(user.id),
    presenceVisible(user.id),
    getProfile(user.id),
    ownAvatar(user.id),
    badgesOf(user.id),
  ]);
  return (
    <SettingsModal title="User settings" closeHref="/app" intercepted={intercepted} groups={[
      { label: "User settings", sections: [
        ["Profile", "My profile"], ["Badges", "Badges"], ["Email address", "Email"], ["Authenticator app", "Two-factor"], ["Passkeys", "Passkeys"], ["Sessions", "Devices"],
      ] },
      { label: "App settings", sections: [["Theme", "Appearance"], ["Notifications", "Notifications"], ["Online status", "Online status"]] },
      { label: "Privacy & safety", sections: [["Blocked people", "Blocked people"], ["Your data", "Your data"], ["Delete account", "Delete account"]] },
    ]}>
      <Section title="Profile" description="Your display name is visible to members of communities you join; your status and bio to your friends. Your email address is not.">
        {mediaEnabled && <AvatarSettings name={user.name} avatar={avatar} />}
        <ProfileForm name={user.name} email={user.email} bio={profile.bio} customStatus={profile.customStatus} />
      </Section>
      <Section title="Badges" description="Shown on your profile.">
        <BadgeOverview badges={badges} />
      </Section>
      <Section title="Theme">
        <ThemeSettings />
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
    </SettingsModal>
  );
}
