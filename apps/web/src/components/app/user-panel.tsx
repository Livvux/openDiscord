import { SettingsIcon } from "lucide-react";
import Link from "next/link";
import type { PresenceChoice } from "@/lib/presence";
import { AccountMenu } from "./account-menu";
import { VoiceBar } from "./voice/voice-bar";

interface UserPanelProps {
  userId: string;
  name: string;
  avatar: string | null;
  presence: PresenceChoice;
  customStatus: string;
}

/** Discord's floating panel across the rail and channel list: voice connection, name tag, settings. */
export function UserPanel(props: UserPanelProps) {
  return (
    <div data-user-panel className="absolute bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] left-[calc(env(safe-area-inset-left)+0.5rem)] z-20 overflow-hidden rounded-lg border bg-card shadow-lg shadow-black/20">
      <VoiceBar />
      <div className="flex h-14 items-center gap-1 px-2">
        <AccountMenu {...props} />
        <Link
          data-user-panel-wide
          href="/app/settings"
          aria-label="User settings"
          title="User settings"
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <SettingsIcon className="size-5" />
        </Link>
      </div>
    </div>
  );
}
