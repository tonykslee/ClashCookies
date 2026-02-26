import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Role,
} from "discord.js";
import { Prisma } from "@prisma/client";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";

function normalizeClanTag(input: string): string {
  const raw = input.trim().toUpperCase().replace(/^#/, "");
  return raw ? `#${raw}` : "";
}

function deriveWarState(raw: string | null | undefined): string {
  const value = String(raw ?? "").toLowerCase();
  if (value.includes("preparation")) return "preparation";
  if (value.includes("inwar")) return "inWar";
  return "notInWar";
}

function normalizeClanTagInput(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

export const Notify: Command = {
  name: "notify",
  description: "Configure notification features",
  options: [
    {
      name: "war",
      description: "Enable war event logs for a clan to a target channel",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Clan tag (tracked or non-tracked)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "target-channel",
          description: "Channel to post war start/battle/end logs",
          type: ApplicationCommandOptionType.Channel,
          required: true,
        },
        {
          name: "role",
          description: "Optional role to ping when war event logs are posted",
          type: ApplicationCommandOptionType.Role,
          required: false,
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guildId) {
      await interaction.editReply("This command can only be used in a server.");
      return;
    }

    const sub = interaction.options.getSubcommand(true);
    if (sub !== "war") {
      await interaction.editReply("Unknown notify option.");
      return;
    }

    const clanTag = normalizeClanTag(interaction.options.getString("clan-tag", true));
    if (!clanTag) {
      await interaction.editReply("Invalid clan tag.");
      return;
    }

    const target = interaction.options.getChannel("target-channel", true);
    const notifyRole = interaction.options.getRole("role", false) as Role | null;
    if (
      target.type !== ChannelType.GuildText &&
      target.type !== ChannelType.GuildAnnouncement
    ) {
      await interaction.editReply("Target channel must be a server text or announcement channel.");
      return;
    }

    const war = await cocService.getCurrentWar(clanTag).catch(() => null);
    const lastState = deriveWarState(war?.state ?? "notInWar");
    const clanName =
      String(war?.clan?.name ?? (await cocService.getClanName(clanTag).catch(() => clanTag))).trim() ||
      clanTag;
    const opponentTag = String(war?.opponent?.tag ?? "").trim() || null;
    const opponentName = String(war?.opponent?.name ?? "").trim() || null;
    const warStartTime = (() => {
      const raw = war?.startTime;
      if (!raw) return null;
      const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.\d{3}Z$/);
      if (!m) return null;
      const [, y, mo, d, h, mi, s] = m;
      return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
    })();

    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "WarEventLogSubscription"
          ("guildId","clanTag","channelId","notify","notifyRole","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","clanName","createdAt","updatedAt")
        VALUES
          (${interaction.guildId}, ${clanTag}, ${target.id}, true, ${notifyRole?.id ?? null}, ${lastState}, ${warStartTime}, ${opponentTag}, ${opponentName}, ${clanName}, NOW(), NOW())
        ON CONFLICT ("guildId","clanTag")
        DO UPDATE SET
          "channelId" = EXCLUDED."channelId",
          "notify" = true,
          "notifyRole" = EXCLUDED."notifyRole",
          "lastState" = EXCLUDED."lastState",
          "lastWarStartTime" = EXCLUDED."lastWarStartTime",
          "lastOpponentTag" = EXCLUDED."lastOpponentTag",
          "lastOpponentName" = EXCLUDED."lastOpponentName",
          "clanName" = EXCLUDED."clanName",
          "updatedAt" = NOW()
      `
    );

    await interaction.editReply(
      `Enabled war event logs for ${clanName} (${clanTag}) in <#${target.id}>.\n` +
        `Notify role: ${notifyRole ? `<@&${notifyRole.id}>` : "none"}\n` +
        `Current state snapshot: \`${lastState}\``
    );
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "clan-tag") {
      await interaction.respond([]);
      return;
    }

    const query = normalizeClanTagInput(String(focused.value ?? "")).toLowerCase();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = tracked
      .map((clan) => {
        const normalizedTag = normalizeClanTagInput(clan.tag);
        const label = clan.name?.trim()
          ? `${clan.name.trim()} (#${normalizedTag})`
          : `#${normalizedTag}`;
        return {
          name: label.slice(0, 100),
          value: normalizedTag,
        };
      })
      .filter(
        (choice) =>
          choice.name.toLowerCase().includes(query) ||
          choice.value.toLowerCase().includes(query)
      )
      .slice(0, 25);

    await interaction.respond(choices);
  },
};
