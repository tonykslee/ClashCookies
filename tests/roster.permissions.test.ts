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

describe("roster permission defaults", () => {
  it("keeps roster list public while create/post/manage/edit/delete stay admin-only by default", async () => {
    const settings = {
      get: vi.fn(async () => null),
    };
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.canUseAnyTarget(["roster:list"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:create"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:post"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:manage"], buildInteraction({ isAdmin: false })),
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
      service.canUseAnyTarget(["roster:readiness"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:refresh"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["roster:list"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:create"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:post"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:manage"], buildInteraction({ isAdmin: true })),
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
      service.canUseAnyTarget(["roster:readiness"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["roster:refresh"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
  });
});
