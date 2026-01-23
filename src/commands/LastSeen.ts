import { CommandInteraction, Client } from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 60) return `${minutes} minute(s) ago`;
  if (hours < 24) return `${hours} hour(s) ago`;
  return `${days} day(s) ago`;
}

export const LastSeen: Command = {
  name: "lastseen",
  description: "Check when a player was last seen active",
  options: [
    {
      name: "tag",
      description: "Player tag (without #)",
      type: 3, // STRING
      required: true,
    },
  ],

  run: async (_client: Client, interaction: CommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const tagInput = interaction.options.get("tag", true).value as string;
    const tag = tagInput.startsWith("#") ? tagInput : `#${tagInput}`;

    const activity = await prisma.playerActivity.findUnique({
      where: { tag },
    });

    if (!activity) {
      await interaction.editReply(
        "⚠️ This player has not been observed yet."
      );
      return;
    }

    const lastSeen = activity.lastSeenAt;
    const relative = formatRelativeTime(lastSeen);

    const signals: string[] = [];
    if (activity.lastDonationAt) signals.push("🎁 donations");
    if (activity.lastCapitalAt) signals.push("🏛 capital raids");
    if (activity.lastTrophyAt) signals.push("🏆 battles");
    if (activity.lastWarAt) signals.push("⚔️ war");
    if (activity.lastBuilderAt) signals.push("🛠 builder base");

    const reason =
      signals.length > 0
        ? `Based on ${signals.join(", ")}`
        : "Based on observation";

    await interaction.editReply(
      `🕒 **Last seen:** ${relative}\n${reason}`
    );
  },
};
