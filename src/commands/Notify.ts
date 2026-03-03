import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Role,
} from "discord.js";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { WarEventLogService } from "../services/WarEventLogService";

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

const NOTIFY_WAR_PREVIEW_POST_PREFIX = "notify-war-preview-post";
const notifyWarPreviewRequests = new Map<
  string,
  {
    userId: string;
    guildId: string;
    clanTag: string;
    eventType: "war_started" | "battle_day" | "war_ended";
    source: "current" | "last";
    channelId: string;
    clanName: string;
    createdAt: number;
  }
>();

function buildNotifyWarPreviewPostCustomId(key: string): string {
  return `${NOTIFY_WAR_PREVIEW_POST_PREFIX}:${key}`;
}

function parseNotifyWarPreviewPostCustomId(
  customId: string
): { key: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 2 || parts[0] !== NOTIFY_WAR_PREVIEW_POST_PREFIX) return null;
  const key = parts[1]?.trim() ?? "";
  if (!key) return null;
  return { key };
}

export function isNotifyWarPreviewPostButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${NOTIFY_WAR_PREVIEW_POST_PREFIX}:`);
}

export async function handleNotifyWarPreviewPostButton(
  interaction: ButtonInteraction,
  cocService: CoCService
): Promise<void> {
  const parsed = parseNotifyWarPreviewPostCustomId(interaction.customId);
  if (!parsed) return;

  const request = notifyWarPreviewRequests.get(parsed.key);
  if (!request) {
    await interaction.reply({
      ephemeral: true,
      content: "This preview has expired. Run `/notify war-preview` again.",
    });
    return;
  }
  if (request.userId !== interaction.user.id) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the user who generated this preview can confirm posting.",
    });
    return;
  }
  if (request.guildId !== interaction.guildId) {
    await interaction.reply({
      ephemeral: true,
      content: "This preview is from a different server.",
    });
    return;
  }
  if (Date.now() - request.createdAt > 30 * 60 * 1000) {
    notifyWarPreviewRequests.delete(parsed.key);
    await interaction.reply({
      ephemeral: true,
      content: "This preview has expired. Run `/notify war-preview` again.",
    });
    return;
  }

  await interaction.deferUpdate();
  const warEventService = new WarEventLogService(interaction.client, cocService);
  const result = await warEventService.emitTestEventForClan({
    guildId: request.guildId,
    clanTag: request.clanTag,
    eventType: request.eventType,
    source: request.source,
  });
  if (!result.ok) {
    await interaction.followUp({
      ephemeral: true,
      content:
      `Failed to post preview publicly for ${request.clanName} (${request.clanTag}): ${result.reason ?? "unknown reason"}`
    });
    return;
  }

  notifyWarPreviewRequests.delete(parsed.key);
  await interaction.deleteReply().catch(async () => {
    await interaction.editReply({
      content:
        `Posted ${request.eventType} for **${request.clanName}** (${request.clanTag}) to <#${request.channelId}>.`,
      embeds: [],
      components: [],
    });
  });
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
        {
          name: "role-ping",
          description: "Whether to ping the configured role in war event logs (default: on)",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
      ],
    },
    {
      name: "toggle",
      description: "Toggle war embed or ping on/off for an existing /notify war subscription",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Clan tag already configured with /notify war",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "target",
          description: "What setting to toggle",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "war embed", value: "war_embed" },
            { name: "ping", value: "ping" },
          ],
        },
        {
          name: "toggle",
          description: "Enable or disable the selected target",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "on", value: "on" },
            { name: "off", value: "off" },
          ],
        },
      ],
    },
    {
      name: "war-preview",
      description: "Preview a war event embed, then confirm posting publicly",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Clan tag (must already be configured with /notify war)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "event",
          description: "Event embed type to test",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "prep day start", value: "war_started" },
            { name: "battle day start", value: "battle_day" },
            { name: "war end", value: "war_ended" },
          ],
        },
        {
          name: "source",
          description: "Data source for test content",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "current war", value: "current" },
            { name: "last war", value: "last" },
          ],
        },
      ],
    },
    {
      name: "show",
      description: "Show war notify routing for tracked clans",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Optional clan tag to show a single clan config",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
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
    if (sub === "show") {
      const rawTag = interaction.options.getString("clan-tag", false);
      const normalizedFilter = rawTag ? normalizeClanTag(rawTag) : "";

      const tracked = await prisma.trackedClan.findMany({
        orderBy: { createdAt: "asc" },
        select: { name: true, tag: true },
      });
      const subscriptions = await prisma.$queryRaw<
        Array<{
          clanTag: string;
          channelId: string;
          notifyRole: string | null;
          notify: boolean;
          pingRole: boolean;
        }>
      >(
        Prisma.sql`
          SELECT "clanTag","channelId","notifyRole","notify","pingRole"
          FROM "WarEventLogSubscription"
          WHERE "guildId" = ${interaction.guildId}
        `
      );
      const subByTag = new Map(
        subscriptions.map((s) => [normalizeClanTag(s.clanTag), s])
      );

      const rows = tracked
        .map((clan) => {
          const clanTag = normalizeClanTag(clan.tag);
          const subRow = subByTag.get(clanTag) ?? null;
          return {
            clanName: clan.name?.trim() || clanTag,
            clanTag,
            channelId: subRow?.channelId ?? null,
            notifyRole: subRow?.notifyRole ?? null,
            enabled: Boolean(subRow?.notify),
            rolePingEnabled: subRow?.pingRole ?? true,
          };
        })
        .filter((r) => (normalizedFilter ? r.clanTag === normalizedFilter : true));

      if (rows.length === 0) {
        await interaction.editReply(
          normalizedFilter
            ? `No tracked clan found for ${normalizedFilter}.`
            : "No tracked clans configured."
        );
        return;
      }

      const lines = rows.map((r) => {
        const channelText = r.channelId ? `<#${r.channelId}>` : "not configured";
        const roleText = r.notifyRole ? `<@&${r.notifyRole}>` : "none";
        const status = r.enabled ? "enabled" : "disabled";
        const rolePing = r.rolePingEnabled ? "on" : "off";
        return `- **${r.clanName}** (${r.clanTag})\n  Channel: ${channelText}\n  Role: ${roleText}\n  Role ping: ${rolePing}\n  Status: ${status}`;
      });

      await interaction.editReply(lines.join("\n"));
      return;
    }

    if (sub === "toggle") {
      const clanTag = normalizeClanTag(interaction.options.getString("clan-tag", true));
      const target = interaction.options.getString("target", true);
      const toggle = interaction.options.getString("toggle", true);
      const enabled = toggle === "on";
      if (target !== "war_embed" && target !== "ping") {
        await interaction.editReply("Invalid target. Use `war embed` or `ping`.");
        return;
      }
      const updated =
        target === "war_embed"
          ? await prisma.$executeRaw(
              Prisma.sql`
                UPDATE "WarEventLogSubscription"
                SET "notify" = ${enabled}, "updatedAt" = NOW()
                WHERE "guildId" = ${interaction.guildId}
                  AND UPPER(REPLACE("clanTag",'#','')) = ${normalizeClanTagInput(clanTag)}
              `
            )
          : await prisma.$executeRaw(
              Prisma.sql`
                UPDATE "WarEventLogSubscription"
                SET "pingRole" = ${enabled}, "updatedAt" = NOW()
                WHERE "guildId" = ${interaction.guildId}
                  AND UPPER(REPLACE("clanTag",'#','')) = ${normalizeClanTagInput(clanTag)}
              `
            );
      if (updated === 0) {
        await interaction.editReply(`No /notify war subscription found for ${clanTag}.`);
        return;
      }

      const targetLabel = target === "war_embed" ? "War embed" : "Ping";
      await interaction.editReply(`${targetLabel} is now **${enabled ? "on" : "off"}** for ${clanTag}.`);
      return;
    }

    if (sub === "war-preview") {
      const clanTag = normalizeClanTag(interaction.options.getString("clan-tag", true));
      const eventType = interaction.options.getString("event", true) as
        | "war_started"
        | "battle_day"
        | "war_ended";
      const source = (interaction.options.getString("source", false) ?? "current") as
        | "current"
        | "last";

      const warEventService = new WarEventLogService(_client, cocService);
      const result = await warEventService.buildTestEventPreviewForClan({
        guildId: interaction.guildId,
        clanTag,
        eventType,
        source,
      });

      if (!result.ok) {
        await interaction.editReply(`Failed to build preview: ${result.reason ?? "unknown reason"}`);
        return;
      }
      if (!result.channelId || !result.clanName || !result.embeds || result.embeds.length === 0) {
        await interaction.editReply("Failed to build preview: incomplete preview payload.");
        return;
      }

      const previewKey = randomUUID();
      notifyWarPreviewRequests.set(previewKey, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        clanTag,
        eventType,
        source,
        channelId: result.channelId,
        clanName: result.clanName,
        createdAt: Date.now(),
      });

      await interaction.editReply({
        content:
          `Preview ready for **${result.clanName}** (${clanTag}).\n` +
          `Target channel: <#${result.channelId}>.\n` +
          "Click **Confirm Post** to publish this embed publicly.",
        embeds: result.embeds ?? [],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(buildNotifyWarPreviewPostCustomId(previewKey))
              .setLabel("Confirm Post")
              .setStyle(ButtonStyle.Success)
          ),
        ],
      });
      return;
    }

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
    const rolePingEnabled = interaction.options.getBoolean("role-ping", false) ?? true;
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
          ("guildId","clanTag","channelId","notify","notifyRole","pingRole","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","clanName","createdAt","updatedAt")
        VALUES
          (${interaction.guildId}, ${clanTag}, ${target.id}, true, ${notifyRole?.id ?? null}, ${rolePingEnabled}, ${lastState}, ${warStartTime}, ${opponentTag}, ${opponentName}, ${clanName}, NOW(), NOW())
        ON CONFLICT ("guildId","clanTag")
        DO UPDATE SET
          "channelId" = EXCLUDED."channelId",
          "notify" = true,
          "notifyRole" = EXCLUDED."notifyRole",
          "pingRole" = EXCLUDED."pingRole",
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
        `Role ping: ${rolePingEnabled ? "on" : "off"}\n` +
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
