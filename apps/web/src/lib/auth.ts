import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { captcha, twoFactor } from "better-auth/plugins";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { ownedCommunityNames, unlinkFromAuditLog } from "@/server/account";
import { authRateLimitStore } from "@/server/rate-limit-store";
import { AccountBlocked, assertActiveUser, getInstanceSettings, isInstanceAdmin } from "@/server/instance-policy";
import { mailEnabled, sendMail } from "./mail";
import { sessionDeviceLabel } from "./session-device";
import { REGISTRATION_HEADER, registrationAttestation } from "./registration-policy";
import { getMinimumAge } from "@/server/operator-policy";

const NAME_MAX = 64;
const APP_NAME = "openDiscord";
// Passkeys are bound to the public origin; BETTER_AUTH_URL is set per deployment.
const publicUrl = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000");

function checkName(name: unknown) {
  if (typeof name === "string" && (name.trim().length === 0 || name.length > NAME_MAX)) {
    throw new APIError("BAD_REQUEST", { message: `Display names need 1–${NAME_MAX} characters.` });
  }
}

// Proxies (CIDRs) whose X-Forwarded-For entries are trusted, e.g. Cloudflare in front of Traefik.
// The client IP is the rightmost untrusted entry, so values a client prepends can't spoof it. Without
// this, Better Auth only accepts single-entry headers and otherwise puts everyone in one shared bucket.
// Non-CIDR tokens (Caddy's "private_ranges" keyword in the same variable) are ignored.
export const trustedProxies = (process.env.TRUSTED_PROXIES ?? "").split(/\s+/).filter((entry) => entry.includes("/"));

// Turnstile is optional for self-hosters; when configured, every sign-up needs a verified token.
const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
if (process.env.NODE_ENV === "production" && !turnstileSecret) {
  console.warn("[auth] TURNSTILE_SECRET_KEY is not set: sign-ups are not protected by Turnstile.");
}

// Reads BETTER_AUTH_SECRET and BETTER_AUTH_URL from the environment.
export const auth = betterAuth({
  appName: APP_NAME,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    requireEmailVerification: mailEnabled,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendMail(user.email, "Reset your openDiscord password", `Choose a new password:\n${url}\n\nIf you didn't ask for this, ignore this email.`);
    },
  },
  emailVerification: {
    sendOnSignUp: mailEnabled,
    // Accounts created before SMTP was configured get a link when they sign in, instead of being locked out.
    sendOnSignIn: mailEnabled,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail(user.email, "Verify your openDiscord account", `Confirm your email address:\n${url}`);
    },
  },
  // Better Auth's per-IP limiter (on in production) plus a stricter window for account creation.
  // Shared in Postgres so limits hold across web replicas; keys are HMACs, never raw IPs (docs/DECISIONS.md D4).
  rateLimit: {
    customStorage: authRateLimitStore,
    customRules: {
      "/sign-up/email": { window: 600, max: 5 },
    },
  },
  advanced: { ipAddress: { trustedProxies } },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-up/email") {
        const minimumAge = getMinimumAge();
        if (ctx.headers?.get(REGISTRATION_HEADER) !== registrationAttestation(minimumAge)) {
          throw new APIError("BAD_REQUEST", { message: `Confirm that you are at least ${minimumAge} and accept the current registration policy.` });
        }
      }
      if (ctx.path !== "/change-email") return;
      // Better Auth 1.7's sensitive-session middleware checks revocation, not freshness.
      const current = await getAuthoritativeSessionFromCtx(ctx);
      if (!current) throw new APIError("UNAUTHORIZED", { message: "Please sign in again." });
      if (Date.now() - current.session.createdAt.getTime() >= 60 * 60_000) {
        throw new APIError("FORBIDDEN", { message: "Sign in again before changing your email address." });
      }
    }),
  },
  user: {
    changeEmail: {
      enabled: mailEnabled,
      updateEmailWithoutVerification: false,
      sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
        await sendMail(user.email, "Confirm your openDiscord email change", `Approve changing your email address to ${newEmail}:\n${url}\n\nAfter approval, we'll verify the new address. If you didn't request this, don't approve it.`);
      },
    },
    additionalFields: {
      // Closed Alpha gate. Only the database hook and instance admins change it; clients can't set it.
      approvalStatus: { type: ["approved", "pending", "rejected"], defaultValue: "approved", input: false, required: true },
    },
    deleteUser: {
      enabled: true,
      beforeDelete: async (user) => {
        if (await isInstanceAdmin(user.id)) {
          throw new APIError("FORBIDDEN", { message: "Remove instance administrator rights before deleting this account." });
        }
        const owned = await ownedCommunityNames(user.id);
        if (owned.length > 0) {
          throw new APIError("BAD_REQUEST", {
            message: `Delete the communities you own first: ${owned.join(", ")}.`,
          });
        }
      },
      afterDelete: async (user) => unlinkFromAuditLog(user.id),
    },
  },
  databaseHooks: {
    user: {
      create: { before: async (user) => {
        checkName(user.name);
        const settings = await getInstanceSettings();
        if (!settings.registrationOpen) {
          throw new APIError("FORBIDDEN", { message: "Registration is closed on this instance." });
        }
        // Set in the same insert, so an account can never exist ungated while Closed Alpha is on.
        return { data: { ...user, approvalStatus: settings.closedAlpha ? "pending" : "approved" } };
      } },
      update: { before: async (user) => checkName(user.name) },
    },
    session: {
      // Privacy: IPs are used in memory for rate limiting but never stored with the session.
      create: { before: async (session) => {
        try { await assertActiveUser(session.userId); } catch (error) {
          if (error instanceof AccountBlocked) {
            throw new APIError("FORBIDDEN", { message: error.message, code: `ACCOUNT_${error.state.toUpperCase()}` });
          }
          throw error;
        }
        return { data: { ...session, ipAddress: null, userAgent: sessionDeviceLabel(session.userAgent) } };
      } },
      update: { before: async (session) => ({ data: {
        ...session,
        ipAddress: null,
        ...(session.userAgent !== undefined && { userAgent: sessionDeviceLabel(session.userAgent) }),
      } }) },
    },
  },
  plugins: [
    // TOTP only becomes active after the first code is verified, so a mis-scanned QR can't lock anyone out.
    twoFactor({ issuer: APP_NAME }),
    ...(turnstileSecret
      ? [captcha({ provider: "cloudflare-turnstile", secretKey: turnstileSecret, endpoints: ["/sign-up/email"] })]
      : []),
    passkey({ rpID: publicUrl.hostname, rpName: APP_NAME, origin: publicUrl.origin }),
    // Must stay last: applies Set-Cookie from server actions.
    nextCookies(),
  ],
});
