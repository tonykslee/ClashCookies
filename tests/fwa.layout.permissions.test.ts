import { describe, expect, it, vi } from "vitest";
import {
  CommandPermissionService,
  getCommandTargetsFromInteraction,
} from "../src/services/CommandPermissionService";

describe("/fwa layout permission defaults", () => {
  it("resolves the dedicated permission target", () => {
    const interaction = {
      commandName: "fwa",
      options: {
        getSubcommandGroup: vi.fn().mockReturnValue(null),
        getSubcommand: vi.fn().mockReturnValue("layout"),
      },
    } as any;

    expect(getCommandTargetsFromInteraction(interaction)).toContain("fwa:layout");
  });

  it("keeps read access open by default while mutation is runtime-admin gated", async () => {
    const service = new CommandPermissionService({
      get: vi.fn(async () => null),
    } as any);
    const allowed = await service.canUseAnyTarget(["fwa:layout"], {
      inGuild: () => true,
      guildId: "guild-1",
      user: { id: "user-1" },
      memberPermissions: { has: () => false },
      member: { roles: [] },
    } as any);

    expect(allowed).toBe(true);
  });
});
