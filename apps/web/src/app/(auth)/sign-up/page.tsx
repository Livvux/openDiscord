import { connection } from "next/server";
import { Suspense } from "react";
import { getInstanceSettings } from "@/server/instance-policy";
import { AuthForm } from "../auth-form";

export default function SignUpPage() {
  return (
    <Suspense>
      <SignUp />
    </Suspense>
  );
}

// Runtime config: the site key and Closed Alpha state can change without a rebuild.
async function SignUp() {
  await connection();
  const { closedAlpha } = await getInstanceSettings();
  return <AuthForm mode="sign-up" closedAlpha={closedAlpha} turnstileSiteKey={process.env.TURNSTILE_SITE_KEY || undefined} />;
}
