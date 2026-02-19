import { Client, CommandInteraction } from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 60) return `${minutes} minute(s) ago`;
  if (hours < 24) return `${hours} hour(s) ago`;
  return `${days} day(s) ago`;
}

// Helpers for reset windows (approximate, ClashPerk-style)
function getSeasonStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function getRaidWeekendStart(): Date {
  const now = new Date();
  const day = now.getUTCDay(); // 5 = Friday
  const diff = (day >= 5 ? day - 5 : day + 2);
  const friday = new Date(now);
  friday.setUTCDate(now.getUTCDate() - diff);
  friday.setUTCHours(7, 0, 0, 0); // Raid weekends start ~7am UTC
  return friday;
}

export const LastSeen: Command = {
  name: "lastseen",
  description: "Check when a player was last seen active",
  options: [
    {
      name: "tag",
      description: "Player tag (without #)",
      type: 3,
      required: true,
    },
  ],

  run: async (client: Client, interaction: CommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const tagInput = interaction.options.get("tag", true).value as string;
    const tag = tagInput.startsWith("#") ? tagInput : `#${tagInput}`;

    // 1️⃣ Try historical data first
    let activity = await prisma.playerActivity.findUnique({
      where: { tag },
    });

    if (activity) {
      const relative = formatRelativeTime(activity.lastSeenAt);

      await interaction.editReply(
        `🕒 **Last seen:** ${relative}\nBased on historical activity`
      );
      return;
    }

    // 2️⃣ LIVE inference fallback (ClashPerk-style)
    try {
      const cocService = new CoCService();
      const player = await cocService.getPlayerRaw(tag);

      if (!player) {
        await interaction.editReply(
          "❌ Invalid player tag or player not found."
        );
        return;
      }
    
      const now = new Date();
      let inferredAt = now;
      const reasons: string[] = [];
    
      if (player.clanCapitalContributions > 0) {
        inferredAt = getRaidWeekendStart();
        reasons.push("🏛 capital raids");
      } else if (player.donations > 0) {
        inferredAt = getSeasonStart();
        reasons.push("🎁 donations this season");
      } else if (player.warStars > 0) {
        inferredAt = getSeasonStart();
        reasons.push("⚔️ war activity");
      } else {
        reasons.push("👀 live observation");
      }
    
      await prisma.playerActivity.upsert({
        where: { tag },
        update: {
          name: player.name,
          clanTag: player.clan?.tag ?? "UNKNOWN",
          lastSeenAt: inferredAt,
        },
        create: {
          tag,
          name: player.name,
          clanTag: player.clan?.tag ?? "UNKNOWN",
          lastSeenAt: inferredAt,
        },
      });
    
      const relative = formatRelativeTime(inferredAt);
    
      await interaction.editReply(
        `🕒 **Last seen:** ${relative}\nBased on ${reasons.join(", ")}`
      );
    } catch (err: any) {
      console.error("LastSeen error:", err.message);
    
      await interaction.editReply(
        "❌ Invalid player tag or player not found."
      );
    }
    
  },
};
