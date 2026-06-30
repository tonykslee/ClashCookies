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
  it("registers rep add/remove/list permission targets", () => {
    expect(COMMAND_PERMISSION_TARGETS).toContain("clan:rep:add");
    expect(COMMAND_PERMISSION_TARGETS).toContain("clan:rep:remove");
    expect(COMMAND_PERMISSION_TARGETS).toContain("clan:rep:list");
  });

  it("resolves rep add/remove/list target paths for permission checks", () => {
    const addTargets = getCommandTargetsFromInteraction(
      buildInteraction({ group: "rep", sub: "add" }),
    );
    const removeTargets = getCommandTargetsFromInteraction(
      buildInteraction({ group: "rep", sub: "remove" }),
    );
    const listTargets = getCommandTargetsFromInteraction(
      buildInteraction({ group: "rep", sub: "list" }),
    );

    expect(addTargets).toContain("clan:rep:add");
    expect(removeTargets).toContain("clan:rep:remove");
    expect(listTargets).toContain("clan:rep:list");
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

  it("keeps rep list available to the fwa leader role or administrators by default", async () => {
    const service = new CommandPermissionService({
      get: vi.fn(async (key: string) => {
        if (String(key).startsWith("fwa_leader_role:")) {
          return "999";
        }
        return null;
      }),
    } as any);

    await expect(
      service.canUseAnyTarget(["clan:rep:list"], buildInteraction({ roleIds: ["999"], group: "rep", sub: "list" })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["clan:rep:list"], buildInteraction({ roleIds: ["123"], group: "rep", sub: "list" })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["clan:rep:list"], buildInteraction({ isAdmin: true, group: "rep", sub: "list" })),
    ).resolves.toBe(true);
  });
});
