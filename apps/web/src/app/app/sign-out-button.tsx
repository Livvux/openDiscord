"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await authClient.signOut();
        router.push("/sign-in");
      }}
      className="rounded-md border border-zinc-700 px-3 py-1 hover:bg-zinc-800"
    >
      Sign out
    </button>
  );
}
