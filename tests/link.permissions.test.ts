import { describe, expect, it, vi } from "vitest";
import {
  COMMAND_PERMISSION_TARGETS,
  CommandPermissionService,
} from "../src/services/CommandPermissionService";

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

describe("link permission defaults", () => {
  it("keeps verify and status registered as explicit permission targets", () => {
    expect(COMMAND_PERMISSION_TARGETS).toContain("link:verify");
    expect(COMMAND_PERMISSION_TARGETS).toContain("link:status");
  });

  it("allows non-admin users for verify and status by default", async () => {
    const settings = {
      get: vi.fn().mockResolvedValue(null),
    };
    const service = new CommandPermissionService(settings as any);
    const interaction = buildInteraction({ isAdmin: false, roleIds: [] });

    await expect(
      service.canUseAnyTarget(["link:verify"], interaction),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["link:status"], interaction),
    ).resolves.toBe(true);
  });

  it("still denies admin-default link operations for non-admin users by default", async () => {
    const settings = {
      get: vi.fn().mockResolvedValue(null),
    };
    const service = new CommandPermissionService(settings as any);
    const interaction = buildInteraction({ isAdmin: false, roleIds: [] });

    await expect(
      service.canUseAnyTarget(["link:embed"], interaction),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["link:sync-clashperk"], interaction),
    ).resolves.toBe(false);
  });

  it("allows admins for verify and status too", async () => {
    const settings = {
      get: vi.fn().mockResolvedValue(null),
    };
    const service = new CommandPermissionService(settings as any);
    const interaction = buildInteraction({ isAdmin: true, roleIds: [] });

    await expect(
      service.canUseAnyTarget(["link:verify"], interaction),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["link:status"], interaction),
    ).resolves.toBe(true);
  });
});
