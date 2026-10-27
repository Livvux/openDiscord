import type { Metadata } from "next";
import { CommunitySettings } from "@/components/app/settings/community-settings";

export const metadata: Metadata = { title: "Community settings" };

export default function CommunitySettingsPage({ params }: PageProps<"/app/c/[communityId]/settings">) {
  return <CommunitySettings params={params} />;
}
