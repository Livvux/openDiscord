import { Suspense } from "react";
import { AuthForm } from "../auth-form";

export default function SignInPage() {
  return (
    <Suspense>
      <AuthForm mode="sign-in" />
    </Suspense>
  );
}
