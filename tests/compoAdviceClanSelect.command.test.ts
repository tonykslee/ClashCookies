import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  handleCompoAdviceClanSelectMenuInteraction,
  parseCompoRefreshCustomIdForTest,
} from "../src/commands/Compo";
import { CompoAdviceService } from "../src/services/CompoAdviceService";

function makeMessageComponents() {
  const select = new StringSelectMenuBuilder()
    .setCustomId("compo-refresh:advice-clan:user-1:actual:AAA111:custom:3:1")
    .setPlaceholder("Viewing: Alpha Clan (#AAA111)")
    .addOptions([
      { label: "Alpha Clan (#AAA111)", value: "AAA111", default: true },
      { label: "Beta Clan (#BBB222)", value: "BBB222" },
    ]);
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
}

function makeInteraction(input?: { userId?: string; selected?: string }) {
  const update = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  return {
    customId: "compo-refresh:advice-clan:user-1:actual:AAA111:custom:3:1",
    user: { id: input?.userId ?? "user-1" },
    guildId: "guild-1",
    values: [input?.selected ?? "BBB222"],
    message: {
      components: makeMessageComponents(),
    },
    update,
    editReply,
    followUp,
    reply,
    replied: false,
    deferred: false,
  } as any;
}

describe("handleCompoAdviceClanSelectMenuInteraction", () => {
  it("switches clans while preserving actual custom band state", async () => {
    const refreshAdviceSpy = vi
      .spyOn(CompoAdviceService.prototype, "refreshAdvice")
      .mockResolvedValue({
        kind: "ready",
        mode: "actual",
        selectedView: "custom",
        trackedClanTags: ["#AAA111", "#BBB222"],
        trackedClanChoices: [
          { tag: "#AAA111", name: "Alpha Clan" },
          { tag: "#BBB222", name: "Beta Clan" },
        ],
        clanTag: "#BBB222",
        clanName: "Beta Clan",
        memberCount: 50,
        rushedCount: 0,
        refreshLine: null,
        summary: {
          mode: "actual",
          view: "custom",
          viewLabel: "Custom",
          currentProjection: {
            memberCount: 50,
            deltaByBucket: {
              TH18: 0,
              TH17: 0,
              TH16: 0,
              TH15: 0,
              TH14: 0,
              "<=TH13": 0,
            },
          } as any,
          currentScore: 0,
          currentBandLabel: "1,000,000 - 2,000,000",
          recommendationText: "Add TH17",
          resultingScore: 0,
          resultingBandLabel: "1,000,000 - 2,000,000",
          alternateTexts: [],
          statusText: null,
          selectedCustomBandIndex: 1,
          customBandCount: 3,
        } as any,
      } as never);
    const interaction = makeInteraction();

    await handleCompoAdviceClanSelectMenuInteraction(interaction);

    expect(refreshAdviceSpy).toHaveBeenCalledWith({
      guildId: "guild-1",
      targetTag: "BBB222",
      mode: "actual",
      view: "custom",
      customBandIndex: 1,
    });
    expect(interaction.update).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalled();
    const payload = interaction.editReply.mock.calls[0]?.[0];
    const customIds = JSON.stringify(payload?.components ?? []);
    expect(customIds).toContain(
      "compo-refresh:advice-clan:user-1:actual:BBB222:custom:3:1",
    );
    expect(customIds).toContain(
      "compo-refresh:advice-band:user-1:BBB222:3:1:prev",
    );
  });

  it("rejects clan switching when the requester does not match", async () => {
    const interaction = makeInteraction({ userId: "user-2" });

    await handleCompoAdviceClanSelectMenuInteraction(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Only the command requester can use this clan selector.",
    });
  });
});

describe("compo advice clan select custom id", () => {
  it("parses the clan-switch payload", () => {
    expect(
      parseCompoRefreshCustomIdForTest(
        "compo-refresh:advice-clan:user-1:actual:AAA111:custom:3:1",
      ),
    ).toMatchObject({
      kind: "advice-clan",
      userId: "user-1",
      mode: "actual",
      targetTag: "AAA111",
      adviceView: "custom",
      customBandCount: 3,
      customBandIndex: 1,
    });
  });
});
