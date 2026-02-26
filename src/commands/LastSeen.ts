import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import {
  ActivitySignalService,
  signalKeyLabel,
  type SignalKey,
} from "../services/ActivitySignalService";

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 60) return `${minutes} minute(s) ago`;
  if (hours < 24) return `${hours} hour(s) ago`;
  return `${days} day(s) ago`;
}

function toDiscordTime(date: Date): string {
  const unix = Math.floor(date.getTime() / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

function normalizePlayerTag(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function getSeasonStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function getRaidWeekendStart(): Date {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day >= 5 ? day - 5 : day + 2;
  const friday = new Date(now);
  friday.setUTCDate(now.getUTCDate() - diff);
  friday.setUTCHours(7, 0, 0, 0);
  return friday;
}

function buildBreakdownRow(prefix: string, showDetails: boolean) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:details`)
      .setLabel("Activity Breakdown")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(showDetails),
    new ButtonBuilder()
      .setCustomId(`${prefix}:back`)
      .setLabel("Back")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!showDetails)
  );
}

type BreakdownInput = {
  tag: string;
  name: string;
  clanTag: string;
  lastSeenAt: Date;
  updatedAt: Date;
  baseSignals: {
    lastDonationAt: Date | null;
    lastCapitalAt: Date | null;
    lastTrophyAt: Date | null;
    lastWarAt: Date | null;
    lastBuilderAt: Date | null;
  };
  extraSignals: Array<{ label: string; at: Date }>;
};

function buildBreakdownText(input: BreakdownInput): string {
  const lines: string[] = [];
  lines.push(`**${input.name}** (${input.tag})`);
  lines.push(`Clan: ${input.clanTag}`);
  lines.push("");
  lines.push(`- Last Seen: ${toDiscordTime(input.lastSeenAt)}`);
  lines.push(
    `- Donations: ${input.baseSignals.lastDonationAt ? toDiscordTime(input.baseSignals.lastDonationAt) : "Not tracked yet"}`
  );
  lines.push(
    `- Capital: ${input.baseSignals.lastCapitalAt ? toDiscordTime(input.baseSignals.lastCapitalAt) : "Not tracked yet"}`
  );
  lines.push(
    `- Trophies: ${input.baseSignals.lastTrophyAt ? toDiscordTime(input.baseSignals.lastTrophyAt) : "Not tracked yet"}`
  );
  lines.push(
    `- War Stars: ${input.baseSignals.lastWarAt ? toDiscordTime(input.baseSignals.lastWarAt) : "Not tracked yet"}`
  );
  lines.push(
    `- Builder: ${input.baseSignals.lastBuilderAt ? toDiscordTime(input.baseSignals.lastBuilderAt) : "Not tracked yet"}`
  );

  if (input.extraSignals.length > 0) {
    lines.push("");
    lines.push("**Additional Signals**");
    for (const signal of input.extraSignals) {
      lines.push(`- ${signal.label}: ${toDiscordTime(signal.at)}`);
    }
  }

  lines.push("");
  lines.push(`- Observation Updated: ${toDiscordTime(input.updatedAt)}`);
  return lines.join("\n");
}

async function renderWithBreakdownButtons(
  interaction: ChatInputCommandInteraction,
  summary: string,
  breakdown: string
): Promise<void> {
  const prefix = `lastseen:${interaction.id}`;
  const reply = await interaction.editReply({
    content: summary,
    components: [buildBreakdownRow(prefix, false)],
  });

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 5 * 60 * 1000,
    filter: (btn) =>
      btn.user.id === interaction.user.id &&
      (btn.customId === `${prefix}:details` || btn.customId === `${prefix}:back`),
  });

  collector.on("collect", async (btn) => {
    if (btn.customId.endsWith(":details")) {
      await btn.update({
        content: breakdown,
        components: [buildBreakdownRow(prefix, true)],
      });
      return;
    }
    await btn.update({
      content: summary,
      components: [buildBreakdownRow(prefix, false)],
    });
  });

  collector.on("end", async () => {
    await interaction.editReply({ components: [] }).catch(() => undefined);
  });
}

export const LastSeen: Command = {
  name: "lastseen",
  description: "Check when a player was last seen active",
  options: [
    {
      name: "tag",
      description: "Player tag (with or without #)",
      type: 3,
      required: true,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });

    const tag = normalizePlayerTag(interaction.options.getString("tag", true));
    if (!tag) {
      await interaction.editReply("❌ Invalid player tag.");
      return;
    }

    const signalService = new ActivitySignalService();
    const activity = await prisma.playerActivity.findUnique({
      where: { tag },
    });

    if (!activity) {
      try {
        const player = await cocService.getPlayerRaw(tag);
        if (!player) {
          await interaction.editReply("❌ Invalid player tag or player not found.");
          return;
        }

        const now = new Date();
        let inferredAt = now;
        const reasons: string[] = [];

        if ((player.clanCapitalContributions ?? 0) > 0) {
          inferredAt = getRaidWeekendStart();
          reasons.push("capital raids");
        } else if ((player.donations ?? 0) > 0 || (player.donationsReceived ?? 0) > 0) {
          inferredAt = getSeasonStart();
          reasons.push("season donations");
        } else if ((player.warStars ?? 0) > 0 || (player.attackWins ?? 0) > 0) {
          inferredAt = getSeasonStart();
          reasons.push("war/activity counters");
        } else {
          reasons.push("live observation");
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

        await signalService.processPlayer({
          tag,
          name: player.name,
          clanTag: player.clan?.tag ?? "UNKNOWN",
          donations: Number(player.donations ?? 0),
          donationsReceived: Number(player.donationsReceived ?? 0),
          capitalGold: Number(player.clanCapitalContributions ?? 0),
          trophies: Number(player.trophies ?? 0),
          builderTrophies: Number(player.builderBaseTrophies ?? player.versusTrophies ?? 0),
          warStars: Number(player.warStars ?? 0),
          attackWins: Number(player.attackWins ?? 0),
          defenseWins: Number(player.defenseWins ?? 0),
          versusBattleWins: Number(player.versusBattleWins ?? 0),
          expLevel: Number(player.expLevel ?? 0),
          achievements: Array.isArray(player.achievements) ? player.achievements : [],
          troops: Array.isArray(player.troops) ? player.troops : [],
          heroes: Array.isArray(player.heroes) ? player.heroes : [],
          spells: Array.isArray(player.spells) ? player.spells : [],
          pets: Array.isArray(player.pets) ? player.pets : [],
          heroEquipment: Array.isArray(player.heroEquipment) ? player.heroEquipment : [],
          nowMs: now.getTime(),
        });

        const relative = formatRelativeTime(inferredAt);
        await interaction.editReply(`🕒 **Last seen:** ${relative}\nBased on ${reasons.join(", ")}`);
        return;
      } catch (err: any) {
        console.error("LastSeen error:", err?.message ?? err);
        await interaction.editReply("❌ Invalid player tag or player not found.");
        return;
      }
    }

    const signalState = await signalService.getState(tag);
    const relative = formatRelativeTime(activity.lastSeenAt);
    const confidence =
      signalState && Object.keys(signalState.signalTimes ?? {}).length >= 4 ? "high" : "medium";
    const summary = `🕒 **Last seen:** ${relative}\nConfidence: **${confidence}**\nBased on historical activity`;

    const extraSignals =
      signalState?.signalTimes
        ? Object.entries(signalState.signalTimes)
            .filter(([, ms]) => Number.isFinite(ms))
            .filter(([key]) =>
              !["donations", "capitalGold", "trophies", "warStars", "builderTrophies"].includes(key)
            )
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .map(([key, ms]) => ({
              label: signalKeyLabel(key as SignalKey),
              at: new Date(Number(ms)),
            }))
        : [];

    const breakdown = buildBreakdownText({
      tag: activity.tag,
      name: activity.name,
      clanTag: activity.clanTag,
      lastSeenAt: activity.lastSeenAt,
      updatedAt: activity.updatedAt,
      baseSignals: {
        lastDonationAt: activity.lastDonationAt ?? null,
        lastCapitalAt: activity.lastCapitalAt ?? null,
        lastTrophyAt: activity.lastTrophyAt ?? null,
        lastWarAt: activity.lastWarAt ?? null,
        lastBuilderAt: activity.lastBuilderAt ?? null,
      },
      extraSignals,
    });

    await renderWithBreakdownButtons(interaction, summary, breakdown);
  },
};
