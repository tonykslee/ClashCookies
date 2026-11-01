import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRole } from "../src/commands/CommandRole";
import { CommandPermissionService } from "../src/services/CommandPermissionService";

const LEADER_ROLE = "111111111111111111";
const FIRST_ROLE = "222222222222222222";
const SECOND_ROLE = "333333333333333333";

afterEach(() => {
  vi.restoreAllMocks();
});

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
      service.canUseAnyTarget(
        ["roster:manage"],
        buildInteraction({ roleIds: [FIRST_ROLE, SECOND_ROLE] }),
      ),
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

  it("keeps a user allowed through a separate role after removing another role", async () => {
    const settings = buildSettings();
    const service = new CommandPermissionService(settings as any);
    await service.addRoleAccess("roster:manage", FIRST_ROLE, "guild-1");
    await service.addRoleAccess("roster:manage", SECOND_ROLE, "guild-1");

    await service.removeRoleAccess("roster:manage", FIRST_ROLE, "guild-1");

    await expect(
      service.canUseAnyTarget(
        ["roster:manage"],
        buildInteraction({ roleIds: [FIRST_ROLE, SECOND_ROLE] }),
      ),
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

  it("lets a child-specific grant override an inherited parent exclusion and lists the same policy", async () => {
    const settings = buildSettings({
      [`command_roles_exclusions:sync`]: FIRST_ROLE,
    });
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.addRoleAccess("sync:retrospective", FIRST_ROLE, "guild-1"),
    ).resolves.toMatchObject({ outcome: "added" });
    await expect(
      service.canUseAnyTarget(
        ["sync:retrospective", "sync"],
        buildInteraction({ roleIds: [FIRST_ROLE] }),
      ),
    ).resolves.toBe(true);
    await expect(
      service.getPolicySummary("sync:retrospective", "guild-1"),
    ).resolves.toEqual(expect.stringContaining(`Explicitly added roles: <@&${FIRST_ROLE}>`));
    await expect(
      service.getPolicySummary("sync:retrospective", "guild-1"),
    ).resolves.toEqual(expect.stringContaining(`Excluded roles/defaults: <@&${FIRST_ROLE}>`));
  });

  it("does not let an excluded role deny a separate child grant", async () => {
    const settings = buildSettings({
      [`command_roles_exclusions:sync`]: FIRST_ROLE,
      [`command_roles_additions:sync:retrospective`]: SECOND_ROLE,
    });
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.canUseAnyTarget(
        ["sync:retrospective", "sync"],
        buildInteraction({ roleIds: [FIRST_ROLE, SECOND_ROLE] }),
      ),
    ).resolves.toBe(true);
  });

  it("does not let a restrictive child policy fall through to its parent", async () => {
    const settings = buildSettings({
      [`command_roles:roster:manage`]: FIRST_ROLE,
      [`command_roles:roster:ping`]: SECOND_ROLE,
    });
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.canUseAnyTarget(
        ["roster:ping", "roster:manage"],
        buildInteraction({ roleIds: [FIRST_ROLE] }),
      ),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(
        ["roster:ping", "roster:manage"],
        buildInteraction({ roleIds: [SECOND_ROLE] }),
      ),
    ).resolves.toBe(true);
    await expect(
      service.getPolicySummary("roster:ping", "guild-1"),
    ).resolves.toEqual(expect.stringContaining("Legacy restrictive whitelist"));
  });

  it("resolves concise add-response roles from the effective default and grants", async () => {
    const settings = buildSettings();
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.getEffectiveAllowedRoleSummary("link:embed", "guild-1"),
    ).resolves.toEqual({ everyone: false, roleIds: [] });

    await service.addRoleAccess("link:embed", FIRST_ROLE, "guild-1");
    await expect(
      service.getEffectiveAllowedRoleSummary("link:embed", "guild-1"),
    ).resolves.toEqual({ everyone: false, roleIds: [FIRST_ROLE] });
  });

  it("includes inherited and FWA Leader grants while filtering restrictive exclusions", async () => {
    const settings = buildSettings({
      [`fwa_leader_role:guild-1`]: LEADER_ROLE,
      [`command_roles:roster:manage`]: FIRST_ROLE,
      [`command_roles_additions:roster:manage`]: SECOND_ROLE,
      [`command_roles_exclusions:roster:manage`]: SECOND_ROLE,
      [`command_roles_exclusions:autorole:refresh`]: LEADER_ROLE,
    });
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.getEffectiveAllowedRoleSummary("roster:ping", "guild-1"),
    ).resolves.toEqual({ everyone: false, roleIds: [FIRST_ROLE, SECOND_ROLE] });

    await expect(
      service.getEffectiveAllowedRoleSummary("autorole:refresh", "guild-1"),
    ).resolves.toEqual({ everyone: false, roleIds: [] });
  });

  it("reports public defaults as Everyone", async () => {
    const service = new CommandPermissionService(buildSettings() as any);

    await expect(
      service.getEffectiveAllowedRoleSummary("help", "guild-1"),
    ).resolves.toEqual({ everyone: true, roleIds: [] });
  });

  it("renders only the current effective allowed-role list after add", async () => {
    vi.spyOn(CommandPermissionService.prototype, "addRoleAccess").mockResolvedValue({
      roleId: FIRST_ROLE,
      outcome: "added",
      policy: {} as any,
    });
    vi.spyOn(
      CommandPermissionService.prototype,
      "getEffectiveAllowedRoleSummary",
    ).mockResolvedValue({ everyone: false, roleIds: [FIRST_ROLE, SECOND_ROLE] });

    const editReply = vi.fn(async () => undefined);
    const interaction = {
      guildId: "guild-1",
      commandName: "permission",
      deferred: true,
      replied: false,
      inGuild: vi.fn().mockReturnValue(true),
      deferReply: vi.fn(async () => undefined),
      editReply,
      options: {
        getSubcommand: vi.fn().mockReturnValue("add"),
        getString: vi.fn().mockReturnValue("link:embed"),
        getRole: vi.fn((name: string) =>
          name === "role" ? { id: FIRST_ROLE } : name === "role2" ? { id: SECOND_ROLE } : null,
        ),
      },
    } as any;

    await CommandRole.run({} as any, interaction, {} as any);

    expect(editReply).toHaveBeenCalledWith({
      ephemeral: true,
      content: `/link:embed\nAllowed: Administrator, <@&${FIRST_ROLE}>, <@&${SECOND_ROLE}>`,
    });
  });
});
