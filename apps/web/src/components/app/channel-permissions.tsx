"use client";

import { useEffect, useState, useTransition } from "react";
import { listChannelOverrides, setChannelOverride } from "@/app/app/actions";
import type { ChannelOverrideView } from "@/server/communities";
import { Permission } from "@/server/permissions";

const COLUMNS = {
  text: [
    { bit: Permission.ViewChannels, label: "View" },
    { bit: Permission.SendMessages, label: "Send" },
    { bit: Permission.ManageMessages, label: "Delete others'" },
  ],
  voice: [
    { bit: Permission.ViewChannels, label: "View" },
    { bit: Permission.Connect, label: "Connect" },
    { bit: Permission.Speak, label: "Speak" },
    { bit: Permission.Video, label: "Video" },
  ],
} as const;

type State = "inherit" | "allow" | "deny";

function stateOf(o: ChannelOverrideView, bit: number): State {
  return o.allow & bit ? "allow" : o.deny & bit ? "deny" : "inherit";
}

/** Tri-state per role and permission. Owners and administrators always bypass these. */
export function ChannelPermissions({ channelId, kind }: { channelId: string; kind: "text" | "voice" }) {
  const columns = COLUMNS[kind];
  const [rows, setRows] = useState<ChannelOverrideView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    void listChannelOverrides(channelId).then((r) => {
      if (!active) return;
      if (r.ok) setRows(r.data);
      else setError(r.error);
    });
    return () => void (active = false);
  }, [channelId]);

  function change(row: ChannelOverrideView, bit: number, next: State) {
    const allow = (row.allow & ~bit) | (next === "allow" ? bit : 0);
    const deny = (row.deny & ~bit) | (next === "deny" ? bit : 0);
    startTransition(async () => {
      const result = await setChannelOverride(channelId, row.roleId, allow, deny);
      if (!result.ok) return setError(result.error);
      setError(null);
      setRows((list) => list?.map((r) => (r.roleId === row.roleId ? { ...r, allow, deny } : r)) ?? null);
    });
  }

  const everyone = rows?.find((r) => r.isDefault);
  const isPrivate = everyone ? (everyone.deny & Permission.ViewChannels) !== 0 : false;

  return (
    <fieldset className="grid gap-2 border-t pt-4" disabled={pending || !rows}>
      <legend className="font-medium">Permissions</legend>
      <p className="text-xs text-muted-foreground">
        {isPrivate
          ? "Private: only roles allowed to view can see this channel."
          : "Set View to Deny for everyone to make this channel private."}{" "}
        Owners and administrators always have access.
      </p>
      {!rows && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {rows && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="px-2 py-1.5 font-medium">Role</th>
                {columns.map((c) => (
                  <th key={c.bit} scope="col" className="px-2 py-1.5 font-medium">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.roleId} className="border-b last:border-0">
                  <th scope="row" className="px-2 py-1 text-left font-normal">{r.isDefault ? "everyone" : r.roleName}</th>
                  {columns.map((c) => (
                    <td key={c.bit} className="px-1 py-1">
                      <select
                        aria-label={`${c.label} for ${r.isDefault ? "everyone" : r.roleName}`}
                        value={stateOf(r, c.bit)}
                        onChange={(e) => change(r, c.bit, e.target.value as State)}
                        className="rounded-md bg-white/5 px-1.5 py-1 text-xs ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <option value="inherit">Default</option>
                        <option value="allow">Allow</option>
                        <option value="deny">Deny</option>
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </fieldset>
  );
}
