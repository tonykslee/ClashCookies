import { describe, expect, it, vi } from "vitest";
import {
  COMMAND_PERMISSION_TARGETS,
  CommandPermissionService,
  getCommandTargetsFromInteraction,
} from "../src/services/CommandPermissionService";
import { getFwaLeaderDefaultTargetsForCommand } from "../src/commands/Help";

function buildInteraction(input: { isAdmin?: boolean; roleIds?: string[] }) {
  return {
    commandName: "sync",
    guildId: "guild-1",
    user: { id: "user-1" },
    inGuild: vi.fn().mockReturnValue(true),
    memberPermissions: {
      has: vi.fn().mockReturnValue(Boolean(input.isAdmin)),
    },
    member: {
      roles: input.roleIds ?? [],
    },
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(null),
      getSubcommand: vi.fn().mockReturnValue("retrospective"),
    },
  } as any;
}

describe("/sync retrospective permissions", () => {
  it("recognizes the exact command target without changing existing sync targets", () => {
    expect(COMMAND_PERMISSION_TARGETS).toContain("sync:retrospective");
    expect(COMMAND_PERMISSION_TARGETS).toContain("sync:time:post");
    expect(COMMAND_PERMISSION_TARGETS).toContain("sync:post:status");
    expect(getCommandTargetsFromInteraction(buildInteraction({}))).toEqual([
      "sync:retrospective",
      "sync",
    ]);
    expect(getFwaLeaderDefaultTargetsForCommand("sync")).toContain("/sync retrospective");
  });

  it("uses the FWA Leader role + Administrator default", async () => {
    const settings = {
      get: vi.fn(async (key: string) => key === "fwa_leader_role:guild-1" ? "222" : null),
    };
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.canUseAnyTarget(["sync:retrospective"], buildInteraction({ roleIds: ["222"] })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["sync:retrospective"], buildInteraction({ roleIds: ["333"] })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["sync:retrospective"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
  });
});
