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

describe("reminders permission defaults", () => {
  it("denies non-admin users by default for reminders targets", async () => {
    const settings = {
      get: vi.fn().mockResolvedValue(null),
    };
    const service = new CommandPermissionService(settings as any);
    const interaction = buildInteraction({ isAdmin: false, roleIds: [] });

    const allowed = await service.canUseAnyTarget(["reminders:list"], interaction);

    expect(allowed).toBe(false);
  });

  it("allows admin users for reminders targets", async () => {
    const settings = {
      get: vi.fn().mockResolvedValue(null),
    };
    const service = new CommandPermissionService(settings as any);
    const interaction = buildInteraction({ isAdmin: true, roleIds: [] });

    const allowed = await service.canUseAnyTarget(["reminders:create"], interaction);

    expect(allowed).toBe(true);
  });
});
