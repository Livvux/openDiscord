import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  // The sign-in form handles the second step itself (no redirect to a separate page).
  plugins: [twoFactorClient(), passkeyClient()],
});
