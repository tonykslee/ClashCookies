import { describe, expect, it, vi } from "vitest";
import {
  COMMAND_PERMISSION_TARGETS,
  CommandPermissionService,
} from "../src/services/CommandPermissionService";

function buildInteraction(input?: { isAdmin?: boolean; isLeader?: boolean }) {
  return {
    guildId: "guild-1",
    user: { id: "user-1" },
    inGuild: vi.fn().mockReturnValue(true),
    memberPermissions: {
      has: vi.fn().mockReturnValue(Boolean(input?.isAdmin)),
    },
    member: {
      roles: {
        cache: new Map(input?.isLeader ? [["123", {}]] : []),
      },
    },
  } as any;
}

describe("cwl permission defaults", () => {
  it("registers cwl activity and removes retired baseline permission targets", () => {
    expect(COMMAND_PERMISSION_TARGETS).toContain("cwl:activity");
    expect(COMMAND_PERMISSION_TARGETS).not.toContain("cwl:baseline");
    expect(COMMAND_PERMISSION_TARGETS).not.toContain("cwl:baseline:status");
    expect(COMMAND_PERMISSION_TARGETS).not.toContain("cwl:baseline:capture");
  });

  it("allows activity to FWA leaders and admins by default", async () => {
    const settings = {
      get: vi.fn(async (key: string) => key === "fwa_leader_role:guild-1" ? "123" : null),
    };
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.canUseAnyTarget(["cwl:activity"], buildInteraction({ isAdmin: false, isLeader: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["cwl:activity"], buildInteraction({ isAdmin: false, isLeader: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["cwl:activity"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
  });

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

  it("keeps /cwl rotations import and export admin-only by default", async () => {
    const settings = {
      get: vi.fn(async () => null),
    };
    const service = new CommandPermissionService(settings as any);

    await expect(
      service.canUseAnyTarget(["cwl:rotations:import"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["cwl:rotations:export"], buildInteraction({ isAdmin: false })),
    ).resolves.toBe(false);
    await expect(
      service.canUseAnyTarget(["cwl:rotations:import"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
    await expect(
      service.canUseAnyTarget(["cwl:rotations:export"], buildInteraction({ isAdmin: true })),
    ).resolves.toBe(true);
  });
});
