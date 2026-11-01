import { describe, expect, it, vi } from "vitest";
import { EmbedBuilder } from "discord.js";
import { truncateDiscordContent } from "../src/helper/discordContent";
import { safeReply } from "../src/helper/safeReply";

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    commandName: "test",
    deferred: false,
    replied: false,
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    ...overrides,
  } as any;
}

describe("safeReply", () => {
  it("preserves content-only replies while truncating content", async () => {
    const interaction = makeInteraction();

    await safeReply(interaction, { content: "x".repeat(2100), ephemeral: true });

    const content = "x".repeat(2100);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: truncateDiscordContent(content),
      ephemeral: true,
    });
  });

  it("supports an embed-only reply", async () => {
    const interaction = makeInteraction();
    const embed = new EmbedBuilder().setTitle("Potion Calculator");

    await safeReply(interaction, { embeds: [embed], ephemeral: true });

    expect(interaction.reply).toHaveBeenCalledWith({
      embeds: [embed],
      ephemeral: true,
    });
  });

  it("edits a deferred embed reply without adding content", async () => {
    const interaction = makeInteraction({ deferred: true });
    const embed = new EmbedBuilder().setDescription("Done");

    await safeReply(interaction, { embeds: [embed], ephemeral: true });

    expect(interaction.editReply).toHaveBeenCalledWith({
      embeds: [embed],
      ephemeral: true,
    });
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});
