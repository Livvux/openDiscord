"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useDmSignOut } from "@/components/app/dm-sign-out";
import { useVoice } from "@/components/app/voice/voice-provider";
import { authClient } from "@/lib/auth-client";

export function SignOutButton({ userId }: { userId: string }) {
  const voice = useVoice();
  const router = useRouter();
  const signOut = useDmSignOut(userId, async () => {
    voice.leave();
    await authClient.signOut();
    router.push("/sign-in");
  });
  return (
    <>
      <Button variant="outline" disabled={signOut.busy} onClick={() => void signOut.request()}>
        Sign out
      </Button>
      {signOut.dialog}
    </>
  );
}
