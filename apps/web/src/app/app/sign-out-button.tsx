"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useVoice } from "@/components/app/voice/voice-provider";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const voice = useVoice();
  const router = useRouter();
  return (
    <Button
      variant="outline"
      onClick={async () => {
        voice.leave();
        await authClient.signOut();
        router.push("/sign-in");
      }}
    >
      Sign out
    </Button>
  );
}
