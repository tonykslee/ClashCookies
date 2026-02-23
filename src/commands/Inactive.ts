import { Client, CommandInteraction } from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { formatError } from "../helper/formatError";

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

  run: async (
    _client: Client,
    interaction: CommandInteraction,
    cocService: CoCService
  ) => {
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

    const trackedTags = dbTracked.map((c) => c.tag);

    const liveMemberTags = new Set<string>();

    for (const trackedTag of trackedTags) {
      try {
        const clan = await cocService.getClan(trackedTag);
        for (const member of clan.members ?? []) {
          const memberTag = String(member?.tag ?? "").trim();
          if (memberTag) {
            liveMemberTags.add(memberTag);
          }
        }
      } catch (err) {
        console.error(
          `inactive: failed to fetch live roster for ${trackedTag}: ${formatError(err)}`
        );
      }
    }

    if (trackedTags.length > 0 && liveMemberTags.size === 0) {
      await interaction.editReply(
        "⚠️ Tracked clans are configured, but live rosters could not be read from CoC API. Try again shortly."
      );
      return;
    }

    const inactivePlayers = await prisma.playerActivity.findMany({
      where: {
        lastSeenAt: {
          lt: cutoff,
        },
        ...(liveMemberTags.size > 0
          ? {
              tag: {
                in: [...liveMemberTags],
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
      message +=
        `\n\nScope: ${trackedTags.length} tracked clan(s), ` +
        `${liveMemberTags.size} live member tag(s).`;
    } else {
      message += "\n\nScope: no tracked clans configured.";
    }

    if (inactivePlayers.length > 25) {
      message += `\n\n…and ${
        inactivePlayers.length - 25
      } more.`;
    }

    await interaction.editReply(message);
  },
};
