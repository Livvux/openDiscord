"use client";

import { BanIcon, CrownIcon, ShieldIcon, UserMinusIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { banMember, kickMember, setMemberRole } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuSub, ContextMenuSubTrigger } from "@/components/ui/context-menu";
import type { MemberSummary, RoleSummary } from "@/server/moderation";
import { canManageRole, has, outranks, Permission, resolveAuthority, type MemberAuthority } from "@/server/permissions";
import { PresenceAvatar } from "../presence-avatar";
import { UserContextMenu } from "../user-context-menu";

interface MembersManagerProps {
  communityId: string;
  currentUserId: string;
  authority: MemberAuthority;
  members: MemberSummary[];
  roles: RoleSummary[];
  blockedUserIds: string[];
}

// Mirrors the server rules to hide controls that would be refused; the server re-checks everything.
export function MembersManager({ communityId, currentUserId, authority, members, roles, blockedUserIds }: MembersManagerProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const assignable = roles.filter((r) => !r.isDefault);
  const defaultRole = roles.find((r) => r.isDefault);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await fn();
      setError(result.ok ? null : (result.error ?? "Something went wrong."));
    });
  }

  function moderate(kind: "kick" | "ban", m: MemberSummary) {
    const reason = window.prompt(`${kind === "kick" ? "Kick" : "Ban"} ${m.name}? Optional reason (shown in the audit log${kind === "ban" ? " and to the banned person" : ""}):`);
    if (reason === null) return;
    run(() => (kind === "kick" ? kickMember : banMember)(communityId, m.userId, reason));
  }

  return (
    <>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <ul className="divide-y rounded-lg border">
        {members.map((m) => {
          const memberRoles = roles.filter((r) => r.isDefault || m.roleIds.includes(r.id));
          const target = resolveAuthority(m.isOwner, memberRoles);
          const isSelf = m.userId === currentUserId;
          const canAct = !isSelf && outranks(authority, target);
          const editableRoles = assignable.filter(
            (r) => canManageRole(authority, r.position, r.permissions) && (isSelf || canAct),
          );
          const canKick = canAct && has(authority, Permission.KickMembers);
          const canBan = canAct && has(authority, Permission.BanMembers);
          return (
            <UserContextMenu
              key={m.userId}
              userId={m.userId}
              name={m.name}
              currentUserId={currentUserId}
              blocked={blockedUserIds.includes(m.userId)}
              disabled={pending}
              onChanged={() => setError(null)}
              onError={setError}
              moderation={editableRoles.length > 0 || canKick || canBan ? (
                <>
                  {editableRoles.length > 0 && (
                    <ContextMenuSub>
                      <ContextMenuSubTrigger><ShieldIcon aria-hidden /> Roles</ContextMenuSubTrigger>
                      <ContextMenuContent aria-label={`Roles for ${m.name}`}>
                        {editableRoles.map((r) => (
                          <ContextMenuCheckboxItem key={r.id} checked={m.roleIds.includes(r.id)} disabled={pending} closeOnClick={false} onCheckedChange={(checked) => run(() => setMemberRole(r.id, m.userId, checked))}>
                            {r.name}
                          </ContextMenuCheckboxItem>
                        ))}
                      </ContextMenuContent>
                    </ContextMenuSub>
                  )}
                  {canKick && <ContextMenuItem variant="destructive" disabled={pending} onClick={() => moderate("kick", m)}><UserMinusIcon aria-hidden /> Kick {m.name}</ContextMenuItem>}
                  {canBan && <ContextMenuItem variant="destructive" disabled={pending} onClick={() => moderate("ban", m)}><BanIcon aria-hidden /> Ban {m.name}</ContextMenuItem>}
                </>
              ) : undefined}
            >
              <li className="flex flex-wrap items-center gap-3 px-3 py-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                <PresenceAvatar userId={m.userId} name={m.name} size="sm" announce />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 font-medium">
                    {m.name}
                    {m.isOwner && <CrownIcon aria-label="Owner" className="size-4 text-amber-400" />}
                    {isSelf && <span className="text-xs text-muted-foreground">(you)</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {memberRoles.filter((r) => r !== defaultRole).map((r) => r.name).join(", ") || "No roles"}
                  </p>
                </div>
                {editableRoles.length > 0 && (
                  <fieldset className="flex flex-wrap gap-2 text-sm">
                    <legend className="sr-only">Roles for {m.name}</legend>
                    {editableRoles.map((r) => (
                      <label key={r.id} className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={m.roleIds.includes(r.id)}
                          disabled={pending}
                          onChange={(e) => run(() => setMemberRole(r.id, m.userId, e.target.checked))}
                        />
                        {r.name}
                      </label>
                    ))}
                  </fieldset>
                )}
                {canKick && (
                  <Button variant="outline" size="sm" disabled={pending} onClick={() => moderate("kick", m)} aria-label={`Kick ${m.name}`}>
                    Kick
                  </Button>
                )}
                {canBan && (
                  <Button variant="destructive" size="sm" disabled={pending} onClick={() => moderate("ban", m)} aria-label={`Ban ${m.name}`}>
                    Ban
                  </Button>
                )}
              </li>
            </UserContextMenu>
          );
        })}
      </ul>
    </>
  );
}
