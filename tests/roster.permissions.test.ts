import { describe, expect, it, vi } from "vitest";
import {
  COMMAND_PERMISSION_TARGETS,
  CommandPermissionService,
  getCommandTargetsFromInteraction,
} from "../src/services/CommandPermissionService";

function buildInteraction(input?: { isAdmin?: boolean; roleIds?: string[] }) {
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

describe("roster permission defaults", () => {
  it("registers ping and maps the slash command to the dedicated target", () => {
    expect(COMMAND_PERMISSION_TARGETS).toContain("roster:ping");
    const interaction = {
      commandName: "roster",
      options: {
        getSubcommandGroup: vi.fn().mockReturnValue(null),
        getSubcommand: vi.fn().mockReturnValue("ping"),
      },
    } as any;

    expect(getCommandTargetsFromInteraction(interaction)).toEqual(["roster:ping"]);
  });

  it("keeps roster list and show public while mutations and ping stay admin-only by default", async () => {
    const settings = {
      get: vi.fn(async () => null),
    };
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.canUseAnyTarget(["roster:list"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:show"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:create"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:set"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:reset"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:post"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:manage"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:ping"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:edit"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:delete"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:report"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:refresh"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:list"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:show"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:create"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:set"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:reset"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:post"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:manage"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:ping"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:edit"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:delete"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:report"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:refresh"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
  });

  it("inherits roster:manage for ping until an explicit ping whitelist exists", async () => {
    const settings = {
      get: vi.fn(async (key: string) => {
        if (key === "command_roles:roster:manage") return "111111111111111111";
        return null;
      }),
    };
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.canUseAnyTarget(["roster:ping"], buildInteraction({ roleIds: ["111111111111111111"] })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:ping"], buildInteraction({ roleIds: ["222222222222222222"] })),
    ).resolves.toBe(false);
    await expect(service.getPolicySummary("roster:ping", "guild-1")).resolves.toBe(
      "Inherited from `/roster:manage`: Allowed roles: <@&111111111111111111>",
    );
  });

  it("lets an explicit ping whitelist override inherited manager access", async () => {
    const settings = {
      get: vi.fn(async (key: string) => {
        if (key === "command_roles:roster:manage") return "111111111111111111";
        if (key === "command_roles:roster:ping") return "333333333333333333";
        return null;
      }),
    };
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.canUseAnyTarget(["roster:ping"], buildInteraction({ roleIds: ["111111111111111111"] })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:ping"], buildInteraction({ roleIds: ["333333333333333333"] })),
    ).resolves.toBe(true);
    await expect(service.getPolicySummary("roster:ping", "guild-1")).resolves.toBe(
      "Allowed roles: <@&333333333333333333>",
    );
  });
});
