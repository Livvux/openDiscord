import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  canManageRole,
  channelAuthority,
  has,
  outranks,
  Permission,
  permissionsFromNames,
  resolveAuthority,
} from "@/server/permissions";

const everyone = { permissions: Permission.SendMessages, position: 0 };
const mod = { permissions: Permission.KickMembers | Permission.ManageMessages | Permission.ManageRoles, position: 2 };
const helper = { permissions: Permission.ManageMessages, position: 1 };

describe("resolveAuthority", () => {
  it("unions role permissions and takes the highest position as rank", () => {
    const a = resolveAuthority(false, [everyone, mod, helper]);
    expect(has(a, Permission.SendMessages)).toBe(true);
    expect(has(a, Permission.KickMembers)).toBe(true);
    expect(has(a, Permission.BanMembers)).toBe(false);
    expect(a.rank).toBe(2);
  });

  it("gives the owner everything and the top rank", () => {
    const owner = resolveAuthority(true, [everyone]);
    expect(owner.permissions).toBe(ALL_PERMISSIONS);
    expect(outranks(owner, resolveAuthority(false, [mod]))).toBe(true);
  });

  it("expands Administrator to all permissions", () => {
    const admin = resolveAuthority(false, [{ permissions: Permission.Administrator, position: 3 }]);
    expect(has(admin, Permission.BanMembers | Permission.ManageCommunity)).toBe(true);
  });
});

describe("hierarchy", () => {
  const owner = resolveAuthority(true, []);
  const moderator = resolveAuthority(false, [everyone, mod]);
  const peer = resolveAuthority(false, [everyone, mod]);
  const member = resolveAuthority(false, [everyone]);

  it("never lets anyone act on the owner", () => {
    expect(outranks(moderator, owner)).toBe(false);
    expect(outranks(owner, owner)).toBe(false);
  });

  it("requires a strictly higher rank", () => {
    expect(outranks(moderator, member)).toBe(true);
    expect(outranks(moderator, peer)).toBe(false);
    expect(outranks(member, moderator)).toBe(false);
  });

  it("blocks granting permissions the actor lacks", () => {
    expect(canManageRole(moderator, 1, Permission.ManageMessages)).toBe(true);
    expect(canManageRole(moderator, 1, Permission.BanMembers)).toBe(false);
  });

  it("blocks managing roles at or above the actor's rank", () => {
    expect(canManageRole(moderator, 2, 0)).toBe(false);
    expect(canManageRole(moderator, 5, 0)).toBe(false);
  });

  it("requires ManageRoles", () => {
    expect(canManageRole(resolveAuthority(false, [helper]), 0, 0)).toBe(false);
  });
});

describe("permissionsFromNames", () => {
  it("ignores unknown names", () => {
    expect(permissionsFromNames(["KickMembers", "Nope", "toString"])).toBe(Permission.KickMembers);
  });
});

describe("channelAuthority", () => {
  const base = resolveAuthority(false, [{ permissions: Permission.ViewChannels | Permission.SendMessages, position: 0 }]);
  const hidden = { roleId: "everyone", allow: 0, deny: Permission.ViewChannels };

  it("lets the default role's deny hide a channel and a member role's allow reveal it", () => {
    expect(has(channelAuthority(base, [hidden], "everyone", ["everyone"]), Permission.ViewChannels)).toBe(false);
    const staff = { roleId: "staff", allow: Permission.ViewChannels, deny: 0 };
    expect(has(channelAuthority(base, [hidden, staff], "everyone", ["everyone", "staff"]), Permission.ViewChannels)).toBe(true);
    // A role override only applies to its holders.
    expect(has(channelAuthority(base, [hidden, staff], "everyone", ["everyone"]), Permission.ViewChannels)).toBe(false);
  });

  it("prefers allow over deny between member roles", () => {
    const muted = { roleId: "muted", allow: 0, deny: Permission.SendMessages };
    const speaker = { roleId: "speaker", allow: Permission.SendMessages, deny: 0 };
    expect(has(channelAuthority(base, [muted], "everyone", ["everyone", "muted"]), Permission.SendMessages)).toBe(false);
    expect(has(channelAuthority(base, [muted, speaker], "everyone", ["everyone", "muted", "speaker"]), Permission.SendMessages)).toBe(true);
  });

  it("never restricts owners and administrators", () => {
    const owner = resolveAuthority(true, []);
    const admin = resolveAuthority(false, [{ permissions: Permission.Administrator, position: 1 }]);
    expect(channelAuthority(owner, [hidden], "everyone", ["everyone"])).toBe(owner);
    expect(has(channelAuthority(admin, [hidden], "everyone", ["everyone", "admin"]), Permission.ViewChannels)).toBe(true);
  });
});
