import { describe, expect, it, vi } from "vitest";
import {
  CommandPermissionService,
  getCommandTargetsFromInteraction,
} from "../src/services/CommandPermissionService";

function buildInteraction(input?: { isAdmin?: boolean; roleIds?: string[]; group?: string; sub?: string }) {
  const roleIds = input?.roleIds ?? [];
  return {
    commandName: "fwa",
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
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(input?.group ?? null),
      getSubcommand: vi.fn().mockReturnValue(input?.sub ?? null),
    },
  } as any;
}

describe("fwa violations permission defaults", () => {
  it("resolves `/fwa violations` target path for permission checks", () => {
    const targets = getCommandTargetsFromInteraction(
      buildInteraction({ sub: "violations" }),
    );

    expect(targets).toContain("fwa:violations");
  });

  it("allows configured FWA leader role for fwa:violations when no explicit whitelist exists", async () => {
    const service = new CommandPermissionService({
      get: vi.fn(async (key: string) =>
        key === "fwa_leader_role:guild-1" ? "222222222222222222" : null,
      ),
    } as any);

    const allowed = await service.canUseAnyTarget(["fwa:violations"], {
      inGuild: () => true,
      guildId: "guild-1",
      user: { id: "111111111111111111" },
      memberPermissions: { has: () => false },
      member: { roles: ["222222222222222222"] },
    } as any);

    expect(allowed).toBe(true);
  });

  it("denies fwa:violations when fwa leader role is unset and user is not admin", async () => {
    const service = new CommandPermissionService({
      get: vi.fn(async () => null),
    } as any);

    const allowed = await service.canUseAnyTarget(["fwa:violations"], {
      inGuild: () => true,
      guildId: "guild-1",
      user: { id: "111111111111111111" },
      memberPermissions: { has: () => false },
      member: { roles: ["333333333333333333"] },
    } as any);

    expect(allowed).toBe(false);
  });

  it("denies fwa:violations when the configured FWA leader role is not held", async () => {
    const service = new CommandPermissionService({
      get: vi.fn(async (key: string) =>
        key === "fwa_leader_role:guild-1" ? "222222222222222222" : null,
      ),
    } as any);

    const allowed = await service.canUseAnyTarget(["fwa:violations"], {
      inGuild: () => true,
      guildId: "guild-1",
      user: { id: "111111111111111111" },
      memberPermissions: { has: () => false },
      member: { roles: ["333333333333333333"] },
    } as any);

    expect(allowed).toBe(false);
  });
});
