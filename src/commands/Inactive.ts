import { Client, CommandInteraction } from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";

function normalizeClanTag(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/^#/, "");
  return `#${cleaned}`;
}

export const Inactive: Command = {
  name: "inactive",
  description: "List players inactive for N days",
  options: [
    {
      name: "days",
      description: "Number of days inactive",
      type: 4, // INTEGER
      required: true,
    },
  ],

  run: async (_client: Client, interaction: CommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const days = interaction.options.get("days", true).value as number;

    if (days <= 0) {
      await interaction.editReply("⚠️ Days must be greater than 0.");
      return;
    }

    const cutoff = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000
    );

    const dbTracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true },
    });

    const trackedTags =
      dbTracked.length > 0
        ? dbTracked.map((c) => c.tag)
        : (process.env.TRACKED_CLANS?.split(",") ?? [])
            .map((t) => t.trim())
            .filter(Boolean)
            .map(normalizeClanTag);

    const inactivePlayers = await prisma.playerActivity.findMany({
      where: {
        lastSeenAt: {
          lt: cutoff,
        },
        ...(trackedTags.length > 0
          ? {
              clanTag: {
                in: trackedTags,
              },
            }
          : {}),
      },
      orderBy: {
        lastSeenAt: "asc",
      },
    });

    if (inactivePlayers.length === 0) {
      await interaction.editReply(
        `✅ No inactive players for ${days}+ days.`
      );
      return;
    }

    // Discord message safety (keep it readable)
    const lines = inactivePlayers.slice(0, 25).map((p) => {
      const daysAgo = Math.floor(
        (Date.now() - p.lastSeenAt.getTime()) /
          (24 * 60 * 60 * 1000)
      );

      return `• **${p.name}** (${p.tag}) — ${daysAgo}d`;
    });

    let message =
      `⚠️ **Inactive for ${days}+ days (${inactivePlayers.length})**\n\n` +
      lines.join("\n");

    if (trackedTags.length > 0) {
      message += `\n\nScope: ${trackedTags.length} tracked clan(s).`;
    } else {
      message +=
        "\n\nScope: all known players (no tracked clans configured).";
    }

    if (inactivePlayers.length > 25) {
      message += `\n\n…and ${
        inactivePlayers.length - 25
      } more.`;
    }

    await interaction.editReply(message);
  },
};
