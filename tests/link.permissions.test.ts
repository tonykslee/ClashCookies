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

  it("keeps raids roster status registered as an explicit permission target", () => {
    expect(COMMAND_PERMISSION_TARGETS).toContain("raids:roster:status");
  });

  it("keeps fwa match checklist registered as an explicit permission target", () => {
    expect(COMMAND_PERMISSION_TARGETS).toContain("fwa:match-checklist");
  });

  it("keeps fwa blacklist import registered as an explicit permission target", () => {
    expect(COMMAND_PERMISSION_TARGETS).toContain("fwa:blacklist-import");
  });

  it("keeps fwa blacklist sample rebuild registered as an explicit permission target", () => {
    expect(COMMAND_PERMISSION_TARGETS).toContain("fwa:blacklist-samples:rebuild");
  });

  it("does not expose fwa mail send as a public permission target", () => {
    expect(COMMAND_PERMISSION_TARGETS).not.toContain("fwa:mail:send");
  });

  it("exposes autorole refresh as an explicit permission target", () => {
    expect(COMMAND_PERMISSION_TARGETS).toContain("autorole:refresh");
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

  it("keeps the hidden fwa mail send policy on the FWA leader default path", async () => {
    const settings = {
      get: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("123456789012345678"),
    };
    const service = new CommandPermissionService(settings as any);
    const interaction = buildInteraction({
      isAdmin: false,
      roleIds: ["123456789012345678"],
    });

    await expect(
      service.canUseCommand("fwa:mail:send", interaction),
    ).resolves.toBe(true);
  });

  it("allows the default fwa leader role for fwa:match-checklist when no explicit whitelist exists", async () => {
    const settings = {
      get: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("123456789012345678"),
    };
    const service = new CommandPermissionService(settings as any);
    const interaction = buildInteraction({
      isAdmin: false,
      roleIds: ["123456789012345678"],
    });

    await expect(
      service.canUseCommand("fwa:match-checklist", interaction),
    ).resolves.toBe(true);
  });

  it("allows admins for fwa:blacklist-import by default", async () => {
    const settings = {
      get: vi.fn().mockResolvedValue(null),
    };
    const service = new CommandPermissionService(settings as any);
    const interaction = buildInteraction({ isAdmin: true, roleIds: [] });

    await expect(
      service.canUseCommand("fwa:blacklist-import", interaction),
    ).resolves.toBe(true);
  });

  it("allows admins for fwa:blacklist-samples:rebuild by default", async () => {
    const settings = {
      get: vi.fn().mockResolvedValue(null),
    };
    const service = new CommandPermissionService(settings as any);
    const interaction = buildInteraction({ isAdmin: true, roleIds: [] });

    await expect(
      service.canUseCommand("fwa:blacklist-samples:rebuild", interaction),
    ).resolves.toBe(true);
  });
});
