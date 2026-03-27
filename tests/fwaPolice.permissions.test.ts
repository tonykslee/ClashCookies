import { describe, expect, it, vi } from "vitest";
import {
  CommandPermissionService,
  getCommandTargetsFromInteraction,
} from "../src/services/CommandPermissionService";

describe("fwa police permission defaults", () => {
  it("resolves `/fwa police` target path for permission checks", () => {
    const targets = getCommandTargetsFromInteraction({
      commandName: "fwa",
      options: {
        getSubcommandGroup: () => null,
        getSubcommand: () => "police",
      },
    } as any);

    expect(targets).toContain("fwa:police");
  });

  it("allows configured FWA leader role for fwa:police when no explicit whitelist exists", async () => {
    const service = new CommandPermissionService({
      get: vi.fn(async (key: string) =>
        key === "fwa_leader_role:guild-1" ? "222222222222222222" : null,
      ),
    } as any);

    const allowed = await service.canUseAnyTarget(["fwa:police"], {
      inGuild: () => true,
      guildId: "guild-1",
      user: { id: "111111111111111111" },
      memberPermissions: { has: () => false },
      member: { roles: ["222222222222222222"] },
    } as any);

    expect(allowed).toBe(true);
  });

  it("denies fwa:police when fwa leader role is unset and user is not admin", async () => {
    const service = new CommandPermissionService({
      get: vi.fn(async () => null),
    } as any);

    const allowed = await service.canUseAnyTarget(["fwa:police"], {
      inGuild: () => true,
      guildId: "guild-1",
      user: { id: "111111111111111111" },
      memberPermissions: { has: () => false },
      member: { roles: ["333333333333333333"] },
    } as any);

    expect(allowed).toBe(false);
  });
});
