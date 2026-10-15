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
  redirect(`/app/c/${view.id}/${view.channels[0].id}`);
  return null;
}
