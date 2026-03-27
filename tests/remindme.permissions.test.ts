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

describe("remindme permission defaults", () => {
  it("allows non-admin users by default for remindme targets", async () => {
    const settings = {
      get: vi.fn().mockResolvedValue(null),
    };
    const service = new CommandPermissionService(settings as any);
    const interaction = buildInteraction({ isAdmin: false, roleIds: [] });

    const allowed = await service.canUseAnyTarget(["remindme:list"], interaction);

    expect(allowed).toBe(true);
  });
});
