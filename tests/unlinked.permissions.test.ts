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

describe("unlinked permission defaults", () => {
  it("allows configured FWA leaders to use unlinked targets by default", async () => {
    const settings = {
      get: vi.fn(async (key: string) => {
        if (key === "fwa_leader_role:guild-1") return "123456789012345678";
        return null;
      }),
    };
    const service = new CommandPermissionService(settings as any);
    const interaction = buildInteraction({ isAdmin: false, roleIds: ["123456789012345678"] });

    await expect(service.canUseAnyTarget(["unlinked:list"], interaction)).resolves.toBe(true);
    await expect(service.canUseAnyTarget(["unlinked:set-alert"], interaction)).resolves.toBe(true);
  });
});
