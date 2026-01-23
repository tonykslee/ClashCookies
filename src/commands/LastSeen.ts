import {
  Client,
  ChatInputCommandInteraction,
  ApplicationCommandOptionType,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { getLastSeen } from "../domain/lastSeen";
import { safeReply } from "../helper/safeReply";

export const LastSeen: Command = {
  name: "lastseen",
  description: "Show when a player was last active",
  options: [
    {
      name: "tag",
      description: "Player tag (example: #82YLR9Q2)",
      type: ApplicationCommandOptionType.String,
      required: true,
    },
  ],
  run: async (
    client: Client,
    interaction: ChatInputCommandInteraction
  ) => {
    const rawTag = interaction.options.getString("tag", true);
    const tag = rawTag.startsWith("#") ? rawTag : `#${rawTag}`;

    const snapshots = await prisma.playerSnapshot.findMany({
      where: { tag },
      orderBy: { createdAt: "asc" },
      take: 50,
    });

    if (snapshots.length === 0) {
      return safeReply(interaction, {
        ephemeral: true,
        content: "⚠️ No activity data recorded yet for this player.",
      });
    }

    const lastSeen = getLastSeen(snapshots);

    if (!lastSeen) {
      return safeReply(interaction, {
        ephemeral: true,
        content: "⚠️ Not enough data to determine last activity.",
      });
    }

    const daysAgo = Math.floor(
      (Date.now() - lastSeen.getTime()) / (1000 * 60 * 60 * 24)
    );

    console.log(
      snapshots.map(s => ({
        trophies: s.trophies,
        donations: s.donations,
        warStars: s.warStars,
        builderTrophies: s.builderTrophies,
        capitalGold: s.capitalGold,
        time: s.createdAt,
      }))
    );
    
    await safeReply(interaction, {
      ephemeral: true,
      content: `🕒 **Last seen:** ${daysAgo} day(s) ago\n(${lastSeen.toUTCString()})`,
    });
  },
};
