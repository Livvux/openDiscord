"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DM_GROUP_MAX_MEMBERS, DM_GROUP_NAME_MAX, type DirectConversation, type DmMemberView } from "@/lib/dm/contracts";
import { Avatar } from "../avatar";

export type FriendOption = { id: string; name: string; avatar: string | null };
const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";

/** Up to three overlapping member avatars. */
export function GroupAvatars({ members }: { members: DmMemberView[] }) {
  const shown = members.filter((m) => !m.left).slice(0, 3);
  return <span aria-hidden className="flex shrink-0 -space-x-3">{shown.map((m) => <span key={m.id} className="rounded-full ring-2 ring-background"><Avatar name={m.name} avatar={m.avatar} size="sm" /></span>)}</span>;
}

function FriendPicker({ friends, picked, onToggle, limit, label }: { friends: FriendOption[]; picked: string[]; onToggle: (id: string) => void; limit: number; label: string }) {
  if (!friends.length) return <p className="text-sm text-muted-foreground">No friends to add.</p>;
  return <fieldset className="grid gap-1"><legend className="mb-1 text-sm">{label}</legend>{friends.map((f) => {
    const checked = picked.includes(f.id);
    return <label key={f.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-white/5"><input type="checkbox" checked={checked} disabled={!checked && picked.length >= limit} onChange={() => onToggle(f.id)} /><Avatar name={f.name} avatar={f.avatar} size="sm" />{f.name}</label>;
  })}</fieldset>;
}
const toggle = (list: string[], id: string) => list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

/** Group creation from the friends list: 2–7 friends plus you. */
export function NewGroupForm({ friends, busy, onCreate, onCancel }: { friends: FriendOption[]; busy: boolean; onCreate: (members: string[], name: string) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  return <form aria-label="New group" className="m-4 grid max-w-lg gap-3 rounded-lg border p-4" onSubmit={(e) => { e.preventDefault(); onCreate(picked, name); }}>
    <h2 className="font-semibold">New encrypted group</h2>
    <p className="text-sm text-muted-foreground">Pick 2–{DM_GROUP_MAX_MEMBERS - 1} friends. Messages are end-to-end encrypted; the group name and who is in it are visible to the server.</p>
    <label className="grid gap-1 text-sm">Group name (optional)<input className={field} maxLength={DM_GROUP_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} /></label>
    <FriendPicker friends={friends} picked={picked} onToggle={(id) => setPicked((list) => toggle(list, id))} limit={DM_GROUP_MAX_MEMBERS - 1} label="Friends" />
    <div className="flex gap-2"><Button type="submit" disabled={busy || picked.length < 2}>Create group</Button><Button type="button" variant="outline" onClick={onCancel}>Cancel</Button></div>
  </form>;
}

/** Rename, add friends, remove people (owner) and leave. */
export function GroupSettings({ conversation, userId, friends, busy, onRename, onAdd, onRemove, onLeave }: {
  conversation: DirectConversation; userId: string; friends: FriendOption[]; busy: boolean;
  onRename: (name: string) => void; onAdd: (ids: string[]) => void; onRemove: (id: string) => void; onLeave: () => void;
}) {
  const [name, setName] = useState(conversation.name ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const current = conversation.members.filter((m) => !m.left);
  const addable = friends.filter((f) => !current.some((m) => m.id === f.id));
  const room = DM_GROUP_MAX_MEMBERS - 1 - current.length;
  return <section aria-label="Group settings" className="m-4 grid max-w-lg gap-4 rounded-lg border p-4">
    <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); onRename(name); }}>
      <label className="grid gap-1 text-sm">Group name<input className={field} maxLength={DM_GROUP_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <p className="text-xs text-muted-foreground">The name is not end-to-end encrypted.</p>
      <Button type="submit" variant="outline" className="w-fit" disabled={busy}>Rename group</Button>
    </form>
    <div className="grid gap-1"><h3 className="text-sm font-semibold">Members ({current.length + 1})</h3><ul className="grid gap-1">
      <li className="text-sm">You{conversation.owner === userId ? " · owner" : ""}</li>
      {current.map((m) => <li key={m.id} className="flex items-center gap-2 text-sm"><Avatar name={m.name} avatar={m.avatar} size="sm" />{m.name}{conversation.owner === m.id ? " · owner" : ""}{m.blocked ? " · blocked: no keys are exchanged" : ""}{conversation.owner === userId && <Button variant="ghost" size="sm" className="ml-auto" disabled={busy} onClick={() => onRemove(m.id)}>Remove {m.name}</Button>}</li>)}
    </ul></div>
    {room > 0 && <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); onAdd(picked); setPicked([]); }}>
      <FriendPicker friends={addable} picked={picked} onToggle={(id) => setPicked((list) => toggle(list, id))} limit={room} label="Add friends (they will not see earlier messages)" />
      {addable.length > 0 && <Button type="submit" variant="outline" className="w-fit" disabled={busy || !picked.length}>Add to group</Button>}
    </form>}
    <Button variant="destructive" className="w-fit" disabled={busy} onClick={() => { if (window.confirm("Leave this group? You will no longer receive or see its messages.")) onLeave(); }}>Leave group</Button>
  </section>;
}
