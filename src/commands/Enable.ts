import {
  ApplicationCommandOptionType,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
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

export const Enable: Command = {
  name: "enable",
  description: "Enable feature settings",
  options: [
    {
      name: "event",
      description: "War event logging settings",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "logs",
          description: "Enable war event logs for a clan to a target channel",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "clan",
              description: "Clan tag (tracked or non-tracked)",
              type: ApplicationCommandOptionType.String,
              required: true,
            },
            {
              name: "target-channel",
              description: "Channel to post war start/battle/end logs",
              type: ApplicationCommandOptionType.Channel,
              required: true,
            },
          ],
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

    const group = interaction.options.getSubcommandGroup(true);
    const sub = interaction.options.getSubcommand(true);
    if (group !== "event" || sub !== "logs") {
      await interaction.editReply("Unknown enable option.");
      return;
    }

    const clanTag = normalizeClanTag(interaction.options.getString("clan", true));
    if (!clanTag) {
      await interaction.editReply("Invalid clan tag.");
      return;
    }

    const target = interaction.options.getChannel("target-channel", true);
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
          ("guildId","clanTag","channelId","enabled","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","lastClanName","createdAt","updatedAt")
        VALUES
          (${interaction.guildId}, ${clanTag}, ${target.id}, true, ${lastState}, ${warStartTime}, ${opponentTag}, ${opponentName}, ${clanName}, NOW(), NOW())
        ON CONFLICT ("guildId","clanTag")
        DO UPDATE SET
          "channelId" = EXCLUDED."channelId",
          "enabled" = true,
          "lastState" = EXCLUDED."lastState",
          "lastWarStartTime" = EXCLUDED."lastWarStartTime",
          "lastOpponentTag" = EXCLUDED."lastOpponentTag",
          "lastOpponentName" = EXCLUDED."lastOpponentName",
          "lastClanName" = EXCLUDED."lastClanName",
          "updatedAt" = NOW()
      `
    );

    await interaction.editReply(
      `Enabled war event logs for ${clanName} (${clanTag}) in <#${target.id}>.\n` +
        `Current state snapshot: \`${lastState}\``
    );
  },
};
