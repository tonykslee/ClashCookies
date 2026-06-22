import { describe, expect, it, vi } from "vitest";
import { CommandPermissionService } from "../src/services/CommandPermissionService";

function buildInteraction(input?: { isAdmin?: boolean; roleIds?: string[] }) {
  const roleIds = input?.roleIds ?? [];
  return {
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
  } as any;
}

describe("autorole permission defaults", () => {
  it("allows FWA Leaders to refresh but keeps config, rules, and exclusions admin-only", async () => {
    const settings = {
      get: vi.fn(async (key: string) => {
        if (key === "fwa_leader_role:guild-1") {
          return "123456789012345678";
        }
        return null;
      }),
    };
    const service = new CommandPermissionService(settings as any);
    const interaction = buildInteraction({
      isAdmin: false,
      roleIds: ["123456789012345678"],
    });

    await expect(
      service.canUseCommand("autorole:refresh", interaction),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["autorole:refresh"], interaction),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["autorole:refresh:user"], interaction),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["autorole:refresh:role"], interaction),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["autorole:config"], interaction),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["autorole:delayed-signup-role"], interaction),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["autorole:rules"], interaction),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["autorole:exclusions"], interaction),
    ).resolves.toBe(false);
  });

  it("reports refresh as FWA Leader + Administrator and config as admin-only", async () => {
    const settings = {
      get: vi.fn(async (key: string) => {
        if (key === "fwa_leader_role:guild-1") {
          return "123456789012345678";
        }
        return null;
      }),
    };
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.getPolicySummary("autorole:refresh", "guild-1"),
    ).resolves.toBe("Default: FWA Leader role <@&123456789012345678> + Administrator.");
    await expect(
      service.getPolicySummary("autorole:refresh:user", "guild-1"),
    ).resolves.toBe("Default: Administrator only.");
    await expect(
      service.getPolicySummary("autorole:config", "guild-1"),
    ).resolves.toBe("Default: Administrator only.");
    await expect(
      service.getPolicySummary("autorole:delayed-signup-role", "guild-1"),
    ).resolves.toBe("Default: Administrator only.");
  });
});
