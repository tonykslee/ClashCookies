import { MessageFlags } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Compo } from "../src/commands/Compo";
import { CompoActualStateService } from "../src/services/CompoActualStateService";

function makeInteraction(visibility: "public" | "private" | null) {
  const interaction: any = {
    guildId: "guild-1",
    user: { id: "user-1" },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: vi.fn(() => "state"),
      getString: vi.fn((name: string) => {
        if (name === "mode") return "actual";
        if (name === "visibility") return visibility;
        return null;
      }),
    },
  };
  return interaction;
}

describe("/compo state visibility", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(CompoActualStateService.prototype, "readState").mockResolvedValue({
      stateRows: [
        ["Clan", "Resolved Total", "Planning Total", "Missing", "DF", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
        ["Alpha", "1,500,000", "1,600,000", "0", "0", "50", "0", "0", "0", "0", "0", "0"],
      ],
      contentLines: ["ACTUAL · View: **Auto-Detect Band** · refreshed <t:1:F>"],
      trackedClanTags: ["#AAA111"],
      renderableClanTags: ["#AAA111"],
      view: "auto",
    });
  });

  it.each([
    ["public", {}],
    ["private", { flags: MessageFlags.Ephemeral }],
  ] as const)("defers %s state with the expected visibility", async (visibility, deferPayload) => {
    const interaction = makeInteraction(visibility);

    await Compo.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).toHaveBeenCalledWith(deferPayload);
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it("defaults omitted visibility to private", async () => {
    const interaction = makeInteraction(null);

    await Compo.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
  });
});
