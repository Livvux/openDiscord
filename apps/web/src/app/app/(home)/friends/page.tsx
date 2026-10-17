import { redirect } from "next/navigation";
import { Suspense } from "react";

/** Friends moved to Home; keep old friend links (/app/friends?add=<code>) working. */
export default function FriendsPage({ searchParams }: PageProps<"/app/friends">) {
  return <Suspense><ToHome searchParams={searchParams} /></Suspense>;
}

async function ToHome({ searchParams }: Pick<PageProps<"/app/friends">, "searchParams">): Promise<never> {
  const { add } = await searchParams;
  redirect(typeof add === "string" && add.length <= 64 ? `/app?add=${encodeURIComponent(add)}` : "/app");
}
