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

  it("lets parent unlinked authorization cover the normal list target set", async () => {
    const settings = {
      get: vi.fn(async (key: string) => {
        if (key === "command_roles:unlinked") return "222222222222222222";
        return null;
      }),
    };
    const service = new CommandPermissionService(settings as any);
    const parentAuthorized = buildInteraction({ roleIds: ["222222222222222222"] });
    const unrelated = buildInteraction({ roleIds: ["333333333333333333"] });
    const normalUnlinkedListTargets = ["unlinked:list", "unlinked"];

    await expect(service.canUseAnyTarget(normalUnlinkedListTargets, parentAuthorized)).resolves.toBe(true);
    await expect(service.canUseAnyTarget(normalUnlinkedListTargets, unrelated)).resolves.toBe(false);
  });
});
