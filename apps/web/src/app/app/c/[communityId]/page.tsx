import { redirect } from "next/navigation";
import { Suspense } from "react";
import { loadCommunityView } from "@/server/pages";
import { requirePageUser } from "@/server/session";

/** Opens the first channel. */
export default function CommunityIndex({ params }: PageProps<"/app/c/[communityId]">) {
  return (
    <Suspense>
      <OpenFirstChannel params={params} />
    </Suspense>
  );
}

async function OpenFirstChannel({ params }: Pick<PageProps<"/app/c/[communityId]">, "params">) {
  const { communityId } = await params;
  const user = await requirePageUser();
  const view = await loadCommunityView(user.id, communityId);
  // Every channel can be private; members without any visible channel still see the sidebar.
  if (view.channels.length === 0) return <p className="m-auto px-6 text-center text-muted-foreground">There are no channels you can see yet.</p>;
  redirect(`/app/c/${view.id}/${view.channels[0].id}`);
}
