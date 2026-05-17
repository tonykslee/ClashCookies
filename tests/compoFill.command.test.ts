import { beforeEach, describe, expect, it, vi } from "vitest";
import { Compo } from "../src/commands/Compo";
import { CompoFillService } from "../src/services/CompoFillService";

function makeInteraction() {
  const interaction: any = {
    commandName: "compo",
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
      getSubcommand: vi.fn(() => "fill"),
      getString: vi.fn(() => null),
    },
  };
  return interaction;
}

describe("/compo fill command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders through the fill service without touching the live CoC client", async () => {
    const readFillSpy = vi.spyOn(CompoFillService.prototype, "readFill").mockResolvedValue({
      content: "",
      embeds: [
        {
          toJSON: () => ({
            title: "Compo Fill Planner",
            description: "Clans under 50: 1 | Open slots: 1 | Available fillers: 1 | Recommended moves: 1",
          }),
        },
      ],
      trackedClanTags: ["#AAA111"],
      destinationClanCount: 1,
      plannedMoveCount: 1,
      availableFillerCount: 1,
    } as any);
    const cocService = {
      getClan: vi.fn(),
      getCurrentWar: vi.fn(),
      getClanWarLog: vi.fn(),
    } as any;

    const interaction = makeInteraction();
    await Compo.run({} as any, interaction as any, cocService);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(readFillSpy).toHaveBeenCalledWith("guild-1");
    expect(cocService.getClan).not.toHaveBeenCalled();
    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(cocService.getClanWarLog).not.toHaveBeenCalled();

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toBe("");
    expect(Array.isArray(payload?.embeds)).toBe(true);
    expect(String(payload?.embeds?.[0]?.toJSON?.()?.description ?? "")).toContain(
      "Clans under 50: 1",
    );
  });
});
