import { describe, expect, it, vi } from "vitest";
import {
  COMMAND_PERMISSION_TARGETS,
  CommandPermissionService,
  getCommandTargetsFromInteraction,
} from "../src/services/CommandPermissionService";

function buildInteraction(input?: { isAdmin?: boolean; roleIds?: string[]; group?: string; sub?: string }) {
  const roleIds = input?.roleIds ?? [];
  return {
    commandName: "clan",
    guildId: "guild-1",
    user: { id: "user-1" },
    inGuild: vi.fn().mockReturnValue(true),
    memberPermissions: {
      has: vi.fn().mockReturnValue(Boolean(input?.isAdmin)),
    },
    member: {
      roles: {
        cache: new Map(roleIds.map((id) => [id, { id }])),
      },
    },
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(input?.group ?? null),
      getSubcommand: vi.fn().mockReturnValue(input?.sub ?? null),
    },
  } as any;
}

describe("tracked-clan permission defaults", () => {
  it("registers rep add/remove permission targets", () => {
    expect(COMMAND_PERMISSION_TARGETS).toContain("clan:rep:add");
    expect(COMMAND_PERMISSION_TARGETS).toContain("clan:rep:remove");
  });

  it("resolves rep add/remove target paths for permission checks", () => {
    const addTargets = getCommandTargetsFromInteraction(
      buildInteraction({ group: "rep", sub: "add" }),
    );
    const removeTargets = getCommandTargetsFromInteraction(
      buildInteraction({ group: "rep", sub: "remove" }),
    );

    expect(addTargets).toContain("clan:rep:add");
    expect(removeTargets).toContain("clan:rep:remove");
  });

  it("keeps rep add/remove admin-only by default", async () => {
    const service = new CommandPermissionService({
      get: vi.fn(async () => null),
    } as any);

    await expect(
      service.canUseAnyTarget(["clan:rep:add"], buildInteraction({ isAdmin: false, group: "rep", sub: "add" })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(
        ["clan:rep:remove"],
        buildInteraction({ isAdmin: false, group: "rep", sub: "remove" }),
      ),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["clan:rep:add"], buildInteraction({ isAdmin: true, group: "rep", sub: "add" })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(
        ["clan:rep:remove"],
        buildInteraction({ isAdmin: true, group: "rep", sub: "remove" }),
      ),
    ).resolves.toBe(true);
  });
});
