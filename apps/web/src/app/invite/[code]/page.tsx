import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { AuthCard } from "@/components/app/auth-card";
import { buttonVariants } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import { getInvitePreview } from "@/server/communities";
import { AppError } from "@/server/errors";
import { JoinButton } from "./join-button";

export const metadata: Metadata = { title: "Invitation", robots: { index: false, follow: false } };

export default function InvitePage({ params }: PageProps<"/invite/[code]">) {
  return (
    <Suspense fallback={<AuthCard title="Loading invitation…">{null}</AuthCard>}>
      <Invite params={params} />
    </Suspense>
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
      <AuthCard title="Invite unavailable" description="This invite is invalid or has expired. Ask for a new link.">
        <Link href="/" className="link">Back to openDiscord</Link>
      </AuthCard>
    );
  }

  const session = await auth.api.getSession({ headers: await headers() });
  const next = encodeURIComponent(`/invite/${preview.code}`);
  return (
    <AuthCard
      title={preview.communityName}
      description={
        <>
          You&apos;ve been invited to join · {preview.memberCount} {preview.memberCount === 1 ? "member" : "members"}
        </>
      }
    >
      {session ? (
        <JoinButton code={preview.code} />
      ) : (
        <div className="grid gap-3">
          <Link href={`/sign-up?next=${next}`} className={buttonVariants({ size: "lg" })}>
            Create an account to join
          </Link>
          <Link href={`/sign-in?next=${next}`} className={buttonVariants({ size: "lg", variant: "outline" })}>
            I already have an account
          </Link>
        </div>
      )}
    </AuthCard>
  );
}
