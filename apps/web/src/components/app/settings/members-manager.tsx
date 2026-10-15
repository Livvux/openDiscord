"use client";

import { CrownIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { banMember, kickMember, setMemberRole } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import type { MemberSummary, RoleSummary } from "@/server/moderation";
import { canManageRole, has, outranks, Permission, resolveAuthority, type MemberAuthority } from "@/server/permissions";
import { PresenceAvatar } from "../presence-avatar";

interface MembersManagerProps {
  communityId: string;
  currentUserId: string;
  authority: MemberAuthority;
  members: MemberSummary[];
  roles: RoleSummary[];
}

// Mirrors the server rules to hide controls that would be refused; the server re-checks everything.
export function MembersManager({ communityId, currentUserId, authority, members, roles }: MembersManagerProps) {
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
          return (
            <li key={m.userId} className="flex flex-wrap items-center gap-3 px-3 py-2">
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
              {canAct && has(authority, Permission.KickMembers) && (
                <Button variant="outline" size="sm" disabled={pending} onClick={() => moderate("kick", m)} aria-label={`Kick ${m.name}`}>
                  Kick
                </Button>
              )}
              {canAct && has(authority, Permission.BanMembers) && (
                <Button variant="destructive" size="sm" disabled={pending} onClick={() => moderate("ban", m)} aria-label={`Ban ${m.name}`}>
                  Ban
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
