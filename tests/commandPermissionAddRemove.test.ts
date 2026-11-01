import { describe, expect, it, vi } from "vitest";
import { CommandPermissionService } from "../src/services/CommandPermissionService";

const LEADER_ROLE = "111111111111111111";
const FIRST_ROLE = "222222222222222222";
const SECOND_ROLE = "333333333333333333";

function buildSettings(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    values,
  };
}

function buildInteraction(input?: { roleIds?: string[]; isAdmin?: boolean }) {
  return {
    guildId: "guild-1",
    user: { id: "user-1" },
    inGuild: vi.fn().mockReturnValue(true),
    memberPermissions: {
      has: vi.fn().mockReturnValue(Boolean(input?.isAdmin)),
    },
    member: {
      roles: {
        cache: new Map((input?.roleIds ?? []).map((id) => [id, { id }])),
      },
    },
  } as any;
}

describe("additive command permission management", () => {
  it("adds a role while preserving FWA Leader and Administrator access", async () => {
    const settings = buildSettings({ [`fwa_leader_role:guild-1`]: LEADER_ROLE });
    const service = new CommandPermissionService(settings as any);

    await expect(service.addRoleAccess("autorole:refresh", FIRST_ROLE, "guild-1")).resolves.toMatchObject({
      outcome: "added",
    });
    await expect(
      service.canUseAnyTarget(["autorole:refresh"], buildInteraction({ roleIds: [LEADER_ROLE] })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["autorole:refresh"], buildInteraction({ roleIds: [FIRST_ROLE] })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["autorole:refresh"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    expect(settings.values.get("command_roles:autorole:refresh")).toBeUndefined();
    expect(settings.values.get("command_roles_additions:autorole:refresh")).toBe(FIRST_ROLE);
  });

  it("supports successive additive grants and is idempotent", async () => {
    const settings = buildSettings();
    const service = new CommandPermissionService(settings as any);

    await expect(service.addRoleAccess("roster:manage", FIRST_ROLE, "guild-1")).resolves.toMatchObject({
      outcome: "added",
    });
    await expect(service.addRoleAccess("roster:manage", SECOND_ROLE, "guild-1")).resolves.toMatchObject({
      outcome: "added",
    });
    await expect(service.addRoleAccess("roster:manage", FIRST_ROLE, "guild-1")).resolves.toMatchObject({
      outcome: "already_allowed",
    });

    await expect(
      service.canUseAnyTarget(["roster:manage"], buildInteraction({ roleIds: [FIRST_ROLE] })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:manage"], buildInteraction({ roleIds: [SECOND_ROLE] })),
    ).resolves.toBe(true);
    expect(settings.values.get("command_roles_additions:roster:manage")).toBe(
      `${FIRST_ROLE},${SECOND_ROLE}`,
    );
  });

  it("removes only the selected additive role and never revokes Administrator", async () => {
    const settings = buildSettings();
    const service = new CommandPermissionService(settings as any);
    await service.addRoleAccess("roster:manage", FIRST_ROLE, "guild-1");
    await service.addRoleAccess("roster:manage", SECOND_ROLE, "guild-1");

    await expect(service.removeRoleAccess("roster:manage", FIRST_ROLE, "guild-1")).resolves.toMatchObject({
      outcome: "removed",
    });
    await expect(
      service.canUseAnyTarget(["roster:manage"], buildInteraction({ roleIds: [FIRST_ROLE] })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:manage"], buildInteraction({ roleIds: [SECOND_ROLE] })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:manage"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
  });

  it("keeps public commands public when adding and supports removing/restoring a default role", async () => {
    const settings = buildSettings();
    const service = new CommandPermissionService(settings as any);

    await expect(service.addRoleAccess("help", FIRST_ROLE, "guild-1")).resolves.toMatchObject({
      outcome: "already_allowed",
    });
    await expect(
      service.canUseAnyTarget(["help"], buildInteraction({ roleIds: [SECOND_ROLE] })),
    ).resolves.toBe(true);

    await expect(service.removeRoleAccess("help", FIRST_ROLE, "guild-1")).resolves.toMatchObject({
      outcome: "excluded",
    });
    await expect(
      service.canUseAnyTarget(["help"], buildInteraction({ roleIds: [FIRST_ROLE] })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["help"], buildInteraction({ roleIds: [SECOND_ROLE] })),
    ).resolves.toBe(true);

    await expect(service.addRoleAccess("help", FIRST_ROLE, "guild-1")).resolves.toMatchObject({
      outcome: "restored",
    });
    await expect(
      service.canUseAnyTarget(["help"], buildInteraction({ roleIds: [FIRST_ROLE] })),
    ).resolves.toBe(true);
    expect(settings.values.get("command_roles_additions:help")).toBeUndefined();
  });

  it("removes and restores the configured FWA Leader default role", async () => {
    const settings = buildSettings({ [`fwa_leader_role:guild-1`]: LEADER_ROLE });
    const service = new CommandPermissionService(settings as any);

    await expect(service.removeRoleAccess("autorole:refresh", LEADER_ROLE, "guild-1")).resolves.toMatchObject({
      outcome: "excluded",
    });
    await expect(
      service.canUseAnyTarget(["autorole:refresh"], buildInteraction({ roleIds: [LEADER_ROLE] })),
    ).resolves.toBe(false);
    await expect(service.addRoleAccess("autorole:refresh", LEADER_ROLE, "guild-1")).resolves.toMatchObject({
      outcome: "restored",
    });
    await expect(
      service.canUseAnyTarget(["autorole:refresh"], buildInteraction({ roleIds: [LEADER_ROLE] })),
    ).resolves.toBe(true);
  });

  it("preserves a legacy restrictive whitelist and does not widen after its last role is removed", async () => {
    const settings = buildSettings({ [`command_roles:roster:manage`]: FIRST_ROLE });
    const service = new CommandPermissionService(settings as any);

    await expect(service.addRoleAccess("roster:manage", SECOND_ROLE, "guild-1")).resolves.toMatchObject({
      outcome: "added",
    });
    expect(settings.values.get("command_roles:roster:manage")).toBe(`${FIRST_ROLE},${SECOND_ROLE}`);
    await expect(service.removeRoleAccess("roster:manage", FIRST_ROLE, "guild-1")).resolves.toMatchObject({
      outcome: "removed",
    });
    await expect(service.removeRoleAccess("roster:manage", SECOND_ROLE, "guild-1")).resolves.toMatchObject({
      outcome: "removed",
    });
    expect(settings.values.get("command_roles:roster:manage")).toBeUndefined();
    expect(settings.values.get("command_roles_restrictive:roster:manage")).toBe("1");
    await expect(
      service.canUseAnyTarget(["roster:manage"], buildInteraction({ roleIds: [FIRST_ROLE] })),
    ).resolves.toBe(false);
    await expect(service.getPolicySummary("roster:manage", "guild-1")).resolves.toContain(
      "Legacy restrictive whitelist",
    );

    await expect(service.addRoleAccess("roster:manage", FIRST_ROLE, "guild-1")).resolves.toMatchObject({
      outcome: "added",
    });
    await expect(
      service.canUseAnyTarget(["roster:manage"], buildInteraction({ roleIds: [FIRST_ROLE] })),
    ).resolves.toBe(true);
  });

  it("keeps child policy precedence while retaining roster:ping inheritance and additive grants", async () => {
    const settings = buildSettings({ [`command_roles:roster:manage`]: FIRST_ROLE });
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.canUseAnyTarget(["roster:ping", "roster:manage"], buildInteraction({ roleIds: [FIRST_ROLE] })),
    ).resolves.toBe(true);
    await service.addRoleAccess("roster:ping", SECOND_ROLE, "guild-1");
    await expect(
      service.canUseAnyTarget(["roster:ping", "roster:manage"], buildInteraction({ roleIds: [FIRST_ROLE] })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:ping", "roster:manage"], buildInteraction({ roleIds: [SECOND_ROLE] })),
    ).resolves.toBe(true);

    const explicitPing = buildSettings({
      [`command_roles:roster:manage`]: FIRST_ROLE,
      [`command_roles:roster:ping`]: SECOND_ROLE,
    });
    const explicitService = new CommandPermissionService(explicitPing as any);
    await expect(
      explicitService.canUseAnyTarget(["roster:ping", "roster:manage"], buildInteraction({ roleIds: [FIRST_ROLE] })),
    ).resolves.toBe(false);
    await expect(
      explicitService.canUseAnyTarget(["roster:ping", "roster:manage"], buildInteraction({ roleIds: [SECOND_ROLE] })),
    ).resolves.toBe(true);
  });

  it("preserves restrictive parent defaults when a child target is public", async () => {
    const settings = buildSettings();
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.canUseAnyTarget(["help", "roster:manage"], buildInteraction({ roleIds: [FIRST_ROLE] })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["help", "roster:manage"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
  });
});
