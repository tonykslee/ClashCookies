import { Client, CommandInteraction } from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";

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

    const inactivePlayers = await prisma.playerActivity.findMany({
      where: {
        lastSeenAt: {
          lt: cutoff,
        },
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

    if (inactivePlayers.length > 25) {
      message += `\n\n…and ${
        inactivePlayers.length - 25
      } more.`;
    }

    await interaction.editReply(message);
  },
};
