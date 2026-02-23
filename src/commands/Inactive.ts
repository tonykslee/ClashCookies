import { Client, CommandInteraction } from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { formatError } from "../helper/formatError";

const DEFAULT_STALE_HOURS = 6;

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
      await interaction.editReply("Days must be greater than 0.");
      return;
    }

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const dbTracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true },
    });
    const trackedTags = dbTracked.map((c) => c.tag);

    if (trackedTags.length === 0) {
      await interaction.editReply(
        "No tracked clans configured. Configure at least one clan with `/tracked-clan add` before using `/inactive`."
      );
      return;
    }

    const liveMemberTags = new Set<string>();
    for (const trackedTag of trackedTags) {
      try {
        const clan = await cocService.getClan(trackedTag);
        for (const member of clan.members ?? []) {
          const memberTag = String(member?.tag ?? "").trim();
          if (memberTag) liveMemberTags.add(memberTag);
        }
      } catch (err) {
        console.error(
          `inactive: failed to fetch live roster for ${trackedTag}: ${formatError(err)}`
        );
      }
    }

    if (liveMemberTags.size === 0) {
      await interaction.editReply(
        "Tracked clans are configured, but live rosters could not be read from CoC API. Try again shortly."
      );
      return;
    }

    const activitySnapshot = await prisma.playerActivity.aggregate({
      where: {
        tag: { in: [...liveMemberTags] },
      },
      _max: { updatedAt: true },
      _count: { tag: true },
    });

    const staleHoursRaw = Number(process.env.INACTIVE_STALE_HOURS ?? DEFAULT_STALE_HOURS);
    const staleHours =
      Number.isFinite(staleHoursRaw) && staleHoursRaw > 0
        ? staleHoursRaw
        : DEFAULT_STALE_HOURS;
    const latestObservedAt = activitySnapshot._max.updatedAt ?? null;
    const staleCutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);

    if (!latestObservedAt || latestObservedAt < staleCutoff) {
      const snapshotAge = latestObservedAt
        ? `<t:${Math.floor(latestObservedAt.getTime() / 1000)}:R>`
        : "unavailable";
      await interaction.editReply(
        `Inactive data is stale (latest observation: ${snapshotAge}). Wait for observation refresh and retry.`
      );
      return;
    }

    const inactivePlayers = await prisma.playerActivity.findMany({
      where: {
        lastSeenAt: { lt: cutoff },
        tag: { in: [...liveMemberTags] },
      },
      orderBy: { lastSeenAt: "asc" },
    });

    if (inactivePlayers.length === 0) {
      await interaction.editReply(`No inactive players for ${days}+ days.`);
      return;
    }

    const lines = inactivePlayers.slice(0, 25).map((p) => {
      const daysAgo = Math.floor((Date.now() - p.lastSeenAt.getTime()) / (24 * 60 * 60 * 1000));
      return `- **${p.name}** (${p.tag}) - ${daysAgo}d`;
    });

    let message =
      `**Inactive for ${days}+ days (${inactivePlayers.length})**\n\n` + lines.join("\n");

    message +=
      `\n\nScope: ${trackedTags.length} tracked clan(s), ` +
      `${liveMemberTags.size} live member tag(s), ` +
      `${activitySnapshot._count.tag} observed player record(s).`;

    if (inactivePlayers.length > 25) {
      message += `\n\n...and ${inactivePlayers.length - 25} more.`;
    }

    await interaction.editReply(message);
  },
};
