import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { AuthCard } from "@/components/app/auth-card";
import { communityImageUrl } from "@/components/app/community-icon";
import { buttonVariants } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import { getInvitePreview } from "@/server/communities";
import { AppError } from "@/server/errors";
import { JoinButton } from "./join-button";

export async function generateMetadata({ params }: PageProps<"/invite/[code]">): Promise<Metadata> {
  const robots = { index: false, follow: false };
  const preview = await getInvitePreview((await params).code).catch((e: unknown) => {
    if (e instanceof AppError) return null;
    throw e;
  });
  if (!preview) return { title: "Invitation", robots };
  const title = `Join ${preview.communityName}`;
  const images = preview.shareImageId ? [communityImageUrl(preview.shareImageId)] : undefined;
  return { title, robots, openGraph: { title, siteName: "openDiscord", images }, twitter: { card: images ? "summary_large_image" : "summary", title, images } };
}

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
      {preview.rules && <section className="mb-4 grid max-h-72 gap-2 overflow-y-auto rounded-lg border p-3"><h2 className="font-semibold">Community rules</h2><p className="whitespace-pre-wrap break-words text-sm">{preview.rules}</p></section>}
      {preview.paused ? (
        <p role="status" className="text-sm text-muted-foreground">This community has paused new members. Ask the person who invited you.</p>
      ) : session ? (
        <JoinButton code={preview.code} rulesVersion={preview.rulesVersion} rulesRequired={preview.rulesRequired} />
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
