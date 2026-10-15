"use client";

import { useState, useTransition } from "react";
import { createRole, deleteRole, updateRole } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RoleSummary } from "@/server/moderation";
import {
  canManageRole,
  Permission,
  PERMISSION_LABELS,
  type MemberAuthority,
  type PermissionName,
} from "@/server/permissions";

const NAMES = Object.keys(PERMISSION_LABELS) as PermissionName[];

interface RolesEditorProps {
  communityId: string;
  authority: MemberAuthority;
  roles: RoleSummary[];
}

export function RolesEditor({ communityId, authority, roles }: RolesEditorProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) {
    startTransition(async () => {
      const result = await fn();
      setError(result.ok ? null : (result.error ?? "Something went wrong."));
      if (result.ok) onOk?.();
    });
  }

  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {roles.map((r) => (
        <RoleForm
          key={r.id}
          role={r}
          authority={authority}
          pending={pending}
          onSave={(name, perms) => run(() => updateRole(r.id, name, perms))}
          onDelete={() => window.confirm(`Delete the role ${r.name}?`) && run(() => deleteRole(r.id))}
        />
      ))}
      <NewRoleForm pending={pending} authority={authority} onCreate={(name, perms, reset) => run(() => createRole(communityId, name, perms), reset)} />
    </div>
  );
}

function PermissionCheckboxes({ authority, initial, disabled, idPrefix }: { authority: MemberAuthority; initial: number; disabled: boolean; idPrefix: string }) {
  return (
    <fieldset className="grid gap-1 sm:grid-cols-2" disabled={disabled}>
      <legend className="sr-only">Permissions</legend>
      {NAMES.map((n) => {
        const grantable = (authority.permissions & Permission[n]) !== 0;
        return (
          <label key={n} htmlFor={`${idPrefix}-${n}`} className={`flex items-center gap-2 text-sm ${grantable ? "" : "opacity-50"}`}>
            <input
              id={`${idPrefix}-${n}`}
              type="checkbox"
              name="permissions"
              value={n}
              defaultChecked={(initial & Permission[n]) !== 0}
              disabled={!grantable}
            />
            {PERMISSION_LABELS[n]}
          </label>
        );
      })}
    </fieldset>
  );
}

function readForm(form: HTMLFormElement): [string, string[]] {
  const data = new FormData(form);
  return [String(data.get("name") ?? ""), data.getAll("permissions").map(String)];
}

function RoleForm({
  role,
  authority,
  pending,
  onSave,
  onDelete,
}: {
  role: RoleSummary;
  authority: MemberAuthority;
  pending: boolean;
  onSave: (name: string, permissions: string[]) => void;
  onDelete: () => void;
}) {
  const editable = canManageRole(authority, role.position, role.isDefault ? 0 : role.permissions);
  return (
    <details className="rounded-lg border">
      <summary className="cursor-pointer px-3 py-2 font-medium">
        {role.isDefault ? "Everyone (default role)" : role.name}
        {!editable && <span className="ml-2 text-xs text-muted-foreground">ranked at or above you</span>}
      </summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(...readForm(e.currentTarget));
        }}
        className="grid gap-3 border-t p-3"
      >
        {!role.isDefault && (
          <div className="grid max-w-xs gap-1.5">
            <Label htmlFor={`role-name-${role.id}`}>Name</Label>
            <Input id={`role-name-${role.id}`} name="name" defaultValue={role.name} required maxLength={32} disabled={!editable} />
          </div>
        )}
        {role.isDefault && <input type="hidden" name="name" value={role.name} />}
        <PermissionCheckboxes authority={authority} initial={role.permissions} disabled={!editable || pending} idPrefix={role.id} />
        {editable && (
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>Save role</Button>
            {!role.isDefault && (
              <Button type="button" variant="destructive" disabled={pending} onClick={onDelete}>
                Delete role
              </Button>
            )}
          </div>
        )}
      </form>
    </details>
  );
}

function NewRoleForm({
  authority,
  pending,
  onCreate,
}: {
  authority: MemberAuthority;
  pending: boolean;
  onCreate: (name: string, permissions: string[], reset: () => void) => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        onCreate(...readForm(form), () => form.reset());
      }}
      className="grid gap-3 rounded-lg border border-dashed p-3"
    >
      <h3 className="font-medium">New role</h3>
      <div className="grid max-w-xs gap-1.5">
        <Label htmlFor="new-role-name">Name</Label>
        <Input id="new-role-name" name="name" required maxLength={32} />
      </div>
      <PermissionCheckboxes authority={authority} initial={0} disabled={pending} idPrefix="new-role" />
      <div>
        <Button type="submit" disabled={pending}>Create role</Button>
      </div>
    </form>
  );
}
