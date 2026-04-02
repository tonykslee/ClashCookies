import { describe, expect, it, vi } from "vitest";
import { CommandPermissionService } from "../src/services/CommandPermissionService";

function buildInteraction(input?: { isAdmin?: boolean }) {
  return {
    guildId: "guild-1",
    user: { id: "user-1" },
    inGuild: vi.fn().mockReturnValue(true),
    memberPermissions: {
      has: vi.fn().mockReturnValue(Boolean(input?.isAdmin)),
    },
    member: {
      roles: {
        cache: new Map(),
      },
    },
  } as any;
}

describe("cwl permission defaults", () => {
  it("keeps /cwl members public while /cwl rotations create stays admin-only by default", async () => {
    const settings = {
      get: vi.fn(async () => null),
    };
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.canUseAnyTarget(["cwl:members"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["cwl:rotations:create"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["cwl:rotations:create"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
  });
});
