import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { Compo, safeFormatUnknownErrorForTest } from "../src/commands/Compo";
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
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("compo-refresh:fill:user-1")
            .setLabel("Refresh Data")
            .setStyle(ButtonStyle.Secondary),
        ),
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
    expect(readFillSpy).toHaveBeenCalledWith("guild-1", {
      userId: "user-1",
    });
    expect(cocService.getClan).not.toHaveBeenCalled();
    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(cocService.getClanWarLog).not.toHaveBeenCalled();

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toBe("");
    expect(Array.isArray(payload?.embeds)).toBe(true);
    expect(Array.isArray(payload?.components)).toBe(true);
    expect(String(payload?.components?.[0]?.toJSON?.()?.components?.[0]?.custom_id ?? "")).toBe(
      "compo-refresh:fill:user-1",
    );
    expect(String(payload?.embeds?.[0]?.toJSON?.()?.description ?? "")).toContain(
      "Clans under 50: 1",
    );
  });

  it("surfaces readFill failures to the user instead of hanging", async () => {
    const events: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      const line = String(args[0] ?? "");
      if (line.includes("stage=response_sent")) {
        events.push("response_sent");
      }
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readFillSpy = vi
      .spyOn(CompoFillService.prototype, "readFill")
      .mockRejectedValue(new Error("fill boom"));
    const cocService = {
      getClan: vi.fn(),
      getCurrentWar: vi.fn(),
      getClanWarLog: vi.fn(),
    } as any;

    const interaction = makeInteraction();
    interaction.editReply = vi.fn(async () => {
      events.push("editReply");
    });
    await Compo.run({} as any, interaction as any, cocService);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(readFillSpy).toHaveBeenCalledTimes(1);
    expect(cocService.getClan).not.toHaveBeenCalled();
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toContain(
      "Failed to build DB-backed compo fill recommendations.",
    );
    expect(Array.isArray(payload?.embeds)).toBe(true);
    expect(Array.isArray(payload?.components)).toBe(true);
    expect(events.indexOf("editReply")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("response_sent")).toBeGreaterThan(events.indexOf("editReply"));
    expect(consoleLogSpy).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("still replies when the thrown error has hostile getters", async () => {
    const hostileError = {
      get name() {
        throw new Error("name boom");
      },
      get message() {
        throw new Error("message boom");
      },
      get stack() {
        throw new Error("stack boom");
      },
    };
    const readFillSpy = vi
      .spyOn(CompoFillService.prototype, "readFill")
      .mockRejectedValue(hostileError as any);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console boom");
    });
    const interaction = makeInteraction();

    await Compo.run({} as any, interaction as any, {
      getClan: vi.fn(),
      getCurrentWar: vi.fn(),
      getClanWarLog: vi.fn(),
    } as any);

    expect(readFillSpy).toHaveBeenCalledTimes(1);
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toContain(
      "Failed to build DB-backed compo fill recommendations.",
    );
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("truncates safe formatter output", () => {
    const formatted = safeFormatUnknownErrorForTest({
      name: "VeryLargeError",
      message: "x".repeat(5000),
      stack: "y".repeat(5000),
    });

    expect(formatted.length).toBeLessThanOrEqual(1800);
    expect(formatted).toContain("name=VeryLargeError");
    expect(formatted).toContain("message=");
    expect(formatted).toContain("stack=");
  });
});
