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
import { LanguageSettings } from "@/components/app/settings/language-settings";
import { getMessages } from "@/lib/i18n/server";

export function AccountSettings({ intercepted = false }: { intercepted?: boolean }) {
  return (
    <Suspense fallback={<div className="p-6 text-primary"><DiamondOrbitSmoothLoader /></div>}>
      <Settings intercepted={intercepted} />
    </Suspense>
  );
}

async function Settings({ intercepted }: { intercepted: boolean }) {
  const user = await requirePageUser();
  const [owned, has2fa, blocked, showPresence, profile, avatar, badges, { settings: t }] = await Promise.all([
    ownedCommunityNames(user.id),
    twoFactorEnabled(user.id),
    listBlocked(user.id),
    presenceVisible(user.id),
    getProfile(user.id),
    ownAvatar(user.id),
    badgesOf(user.id),
    getMessages(),
  ]);
  return (
    // Section ids stay English: links and saved positions point at them in every language.
    <SettingsModal title={t.title} closeHref="/app" intercepted={intercepted} groups={[
      { label: t.groupUser, sections: [
        ["Profile", t.myProfile], ["Badges", t.badges], ["Email address", t.email], ["Authenticator app", t.twoFactor], ["Passkeys", t.passkeys], ["Sessions", t.devices],
      ] },
      { label: t.groupApp, sections: [["Theme", t.appearance], ["Language", t.language], ["Notifications", t.notifications], ["Online status", t.onlineStatus]] },
      { label: t.groupPrivacy, sections: [["Blocked people", t.blocked], ["Your data", t.yourData], ["Delete account", t.deleteAccount]] },
    ]}>
      <Section id="Profile" title={t.profile} description="Your display name is visible to members of communities you join; your status and bio to your friends. Your email address is not.">
        {mediaEnabled && <AvatarSettings name={user.name} avatar={avatar} />}
        <ProfileForm name={user.name} email={user.email} bio={profile.bio} customStatus={profile.customStatus} />
      </Section>
      <Section id="Badges" title={t.badges} description="Shown on your profile.">
        <BadgeOverview badges={badges} />
      </Section>
      <Section id="Theme" title={t.theme}>
        <ThemeSettings />
      </Section>
      <Section id="Language" title={t.language}>
        <LanguageSettings />
      </Section>
      <Section id="Email address" title={t.emailAddress} description="Changes require a recent sign-in and verification. Your email is never shown to other members.">
        {mailEnabled ? <EmailSettings email={user.email} /> : <p className="text-sm text-muted-foreground">Email changes are unavailable because this instance has not configured email delivery.</p>}
      </Section>
      <Section id="Notifications" title={t.notifications} description="Mentions always show a badge in the app. Desktop notifications are optional.">
        <NotificationSettings />
        {pushEnabled && vapidPublicKey && <PushSettings publicKey={vapidPublicKey} />}
      </Section>
      <Section id="Online status" title={t.onlineStatus} description="Off by default. When on, members of your communities and your friends see a dot while you have openDiscord open. Choose Idle or Do not disturb from the account menu.">
        <PresenceSettings visible={showPresence} />
      </Section>
      <Section id="Blocked people" title={t.blocked} description="Their messages are collapsed for you and their mentions don't notify you. They aren't told.">
        <BlockedList blocked={blocked} currentUserId={user.id} />
      </Section>
      <Section id="Authenticator app" title={t.authenticator} description="Optional two-factor authentication with a time-based code (TOTP).">
        <TwoFactorSettings enabled={has2fa} />
      </Section>
      <Section id="Passkeys" title={t.passkeys} description="Sign in with Face ID, Touch ID, Windows Hello or a security key.">
        <PasskeySettings />
      </Section>
      <Section id="Sessions" title={t.sessions} description="Devices currently signed in to your account.">
        <Sessions />
        <SignOutButton userId={user.id} />
      </Section>
      <Section id="Your data" title={t.yourData} description="Download your profile, sessions, security settings, memberships and messages as JSON.">
        <a
          href="/api/me/export"
          download
          className="inline-flex h-8 items-center rounded-lg border px-3 text-sm font-medium hover:bg-muted"
        >
          {t.downloadData}
        </a>
      </Section>
      <Section id="Delete account" title={t.deleteAccount} description="Permanently deletes your account, your sessions and every message you wrote. This can't be undone.">
        <DeleteAccount ownedCommunities={owned} />
      </Section>
    </SettingsModal>
  );
}
