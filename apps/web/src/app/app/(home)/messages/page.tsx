import type { Metadata } from "next";
import { Suspense } from "react";
import { PrivateMessages } from "@/components/app/dm/private-messages";
import { ownAvatar } from "@/server/avatars";
import { homeFriends } from "@/server/home";
import { mediaEnabled } from "@/server/media";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Private messages" };
export default function PrivateMessagesPage({ searchParams }: PageProps<"/app/messages">) {
  return <main className="flex min-w-0 flex-1 flex-col"><Suspense fallback={<p className="p-6">Loading private messages…</p>}><Messages searchParams={searchParams} /></Suspense></main>;
}
async function Messages({ searchParams }: Pick<PageProps<"/app/messages">, "searchParams">) {
  const user = await requirePageUser();
  const [params, friends, avatar] = await Promise.all([searchParams, homeFriends(user.id), ownAvatar(user.id)]);
  const target = typeof params.to === "string" && params.to.length <= 64 && params.to !== user.id ? params.to : undefined;
  const targetIsFriend = !!target && friends.some((f) => f.id === target && f.state === "friend");
  const conversation = typeof params.c === "string" && /^[0-9a-f-]{36}$/.test(params.c) ? params.c : undefined;
  const friendOptions = friends.filter((f) => f.state === "friend").map((f) => ({ id: f.id, name: f.name, avatar: f.avatar }));
  // Remount per target so a new ?to= or ?c= selects its conversation (the encryption client is cached).
  return <PrivateMessages key={`${target ?? ""}:${conversation ?? ""}`} userId={user.id} userName={user.name} userAvatar={avatar} target={target} targetIsFriend={targetIsFriend} attachmentsEnabled={mediaEnabled} conversation={conversation} friends={friendOptions} />;
}
