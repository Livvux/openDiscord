import type { FriendView } from "@/server/friends";
import { UserProfilePopover } from "../user-profile";
import { PresenceAvatar } from "../presence-avatar";

/** Discord's right-hand "Active Now": friends currently online (desktop only). */
export function ActiveNow({ userId, friends }: { userId: string; friends: FriendView[] }) {
  return (
    <aside aria-labelledby="active-now-heading" className="hidden w-80 shrink-0 overflow-y-auto border-l border-white/5 p-4 xl:block">
      <h2 id="active-now-heading" className="mb-3 text-lg font-semibold text-zinc-50">Active Now</h2>
      {friends.length === 0 ? (
        <div className="rounded-lg bg-panel/60 p-4 text-center">
          <p className="font-medium text-zinc-100">It&apos;s quiet for now…</p>
          <p className="mt-1 text-sm text-muted-foreground">When a friend is online, they&apos;ll show up here.</p>
        </div>
      ) : (
        <ul className="grid gap-2">
          {friends.map((f) => (
            <li key={f.id}>
              <UserProfilePopover userId={f.id} currentUserId={userId} render={
                <button type="button" className="flex w-full items-center gap-3 rounded-lg bg-panel/60 p-3 text-left hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-ring">
                  <PresenceAvatar userId={f.id} name={f.name} status={f.presence} announce />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-zinc-100">{f.name}</span>
                    {f.customStatus && <span className="block truncate text-xs text-muted-foreground">{f.customStatus}</span>}
                  </span>
                </button>
              } />
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
