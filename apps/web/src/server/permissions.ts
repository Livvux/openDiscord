// Community permission model: roles carry a bit set; a member's effective permissions are the
// union of their roles plus the community's default role. The owner implicitly has everything.
// Hierarchy: a member may only act on members, and manage roles, ranked strictly below their
// own highest role. This prevents moderators from escalating their own privileges.

export const Permission = {
  Administrator: 1 << 0,
  ManageCommunity: 1 << 1,
  ManageChannels: 1 << 2,
  ManageRoles: 1 << 3,
  ManageMessages: 1 << 4,
  KickMembers: 1 << 5,
  BanMembers: 1 << 6,
  CreateInvites: 1 << 7,
  SendMessages: 1 << 8,
  ViewAuditLog: 1 << 9,
} as const;

export type PermissionName = keyof typeof Permission;

export const ALL_PERMISSIONS = Object.values(Permission).reduce((a, b) => a | b, 0);
export const DEFAULT_MEMBER_PERMISSIONS = Permission.SendMessages | Permission.CreateInvites;

/** Human-readable labels for the role editor, in display order. */
export const PERMISSION_LABELS: Record<PermissionName, string> = {
  Administrator: "Administrator (all permissions)",
  ManageCommunity: "Manage community",
  ManageChannels: "Manage channels",
  ManageRoles: "Manage roles",
  ManageMessages: "Delete others' messages",
  KickMembers: "Kick members",
  BanMembers: "Ban members",
  CreateInvites: "Create invites",
  SendMessages: "Send messages",
  ViewAuditLog: "View audit log",
};

export interface MemberAuthority {
  isOwner: boolean;
  permissions: number;
  /** Highest role position the member holds; the owner ranks above every role. */
  rank: number;
}

export const OWNER_RANK = Number.MAX_SAFE_INTEGER;

export function resolveAuthority(
  isOwner: boolean,
  roles: ReadonlyArray<{ permissions: number; position: number }>,
): MemberAuthority {
  if (isOwner) return { isOwner, permissions: ALL_PERMISSIONS, rank: OWNER_RANK };
  const permissions = roles.reduce((acc, r) => acc | r.permissions, 0);
  const rank = roles.reduce((acc, r) => Math.max(acc, r.position), 0);
  return {
    isOwner,
    permissions: permissions & Permission.Administrator ? ALL_PERMISSIONS : permissions,
    rank,
  };
}

export function has(authority: MemberAuthority, permission: number): boolean {
  return (authority.permissions & permission) === permission;
}

/** Whether `actor` may moderate `target` (kick, ban, change roles). */
export function outranks(actor: MemberAuthority, target: MemberAuthority): boolean {
  if (target.isOwner) return false;
  return actor.rank > target.rank;
}

/**
 * Whether `actor` may create or edit a role with the given position and permissions:
 * it must sit below the actor and must not grant anything the actor lacks.
 */
export function canManageRole(actor: MemberAuthority, rolePosition: number, rolePermissions: number): boolean {
  if (!has(actor, Permission.ManageRoles)) return false;
  if (rolePosition >= actor.rank) return false;
  return (rolePermissions & ~actor.permissions) === 0;
}

export function permissionsFromNames(names: readonly string[]): number {
  return names.reduce((acc, n) => (Object.hasOwn(Permission, n) ? acc | Permission[n as PermissionName] : acc), 0);
}
