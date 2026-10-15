import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { Logo } from "@/components/logo";
import { auth } from "@/lib/auth";
import { getInvitePreview } from "@/server/communities";
import { AppError } from "@/server/errors";
import { JoinButton } from "./join-button";

export const metadata: Metadata = { title: "Invitation", robots: { index: false, follow: false } };

export default function InvitePage({ params }: PageProps<"/invite/[code]">) {
  return (
    <main className="flex flex-1 items-center justify-center bg-background p-8 text-foreground">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border bg-card p-8 text-center">
        <div className="flex justify-center">
          <Logo />
        </div>
        <Suspense fallback={<p className="text-muted-foreground">Loading invitation…</p>}>
          <Invite params={params} />
        </Suspense>
      </div>
    </main>
  );
}

async function Invite({ params }: Pick<PageProps<"/invite/[code]">, "params">) {
  const { code } = await params;
  const preview = await getInvitePreview(code).catch((e: unknown) => {
    if (e instanceof AppError) return null;
    throw e;
  });
  if (!preview) {
    return (
      <>
        <h1 className="text-xl font-semibold">Invite unavailable</h1>
        <p className="text-muted-foreground">This invite is invalid or has expired. Ask for a new link.</p>
      </>
    );
  }

  const session = await auth.api.getSession({ headers: await headers() });
  const next = encodeURIComponent(`/invite/${preview.code}`);
  return (
    <>
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">You&apos;ve been invited to join</p>
        <h1 className="text-2xl font-semibold break-words">{preview.communityName}</h1>
        <p className="text-sm text-muted-foreground">
          {preview.memberCount} {preview.memberCount === 1 ? "member" : "members"}
        </p>
      </div>
      {session ? (
        <JoinButton code={preview.code} />
      ) : (
        <div className="grid gap-2">
          <Link href={`/sign-up?next=${next}`} className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/80">
            Create an account to join
          </Link>
          <Link href={`/sign-in?next=${next}`} className="text-sm text-brand-cyan hover:underline">
            I already have an account
          </Link>
        </div>
      )}
    </>
  );
}
