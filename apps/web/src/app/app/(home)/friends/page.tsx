import { redirect } from "next/navigation";

/** Friends moved to Home; keep old friend links (/app/friends?add=<code>) working. */
export default async function FriendsPage({ searchParams }: PageProps<"/app/friends">) {
  const { add } = await searchParams;
  redirect(typeof add === "string" && add.length <= 64 ? `/app?add=${encodeURIComponent(add)}` : "/app");
}
