import {
  ApplicationCommandOptionType,
  AttachmentBuilder,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
} from "discord.js";
import { Prisma } from "@prisma/client";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";

function normalizeClanTagInput(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

function normalizeClanTag(input: string): string {
  const tag = normalizeClanTagInput(input);
  return tag ? `#${tag}` : "";
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unknown";
  return `${value.toFixed(2)}%`;
}

function csvEscape(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  if (!/[",\r\n]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, "\"\"")}"`;
}

function buildCsv(rows: Array<Record<string, unknown>>, headers: string[]): string {
  const out: string[] = [];
  out.push(headers.join(","));
  for (const row of rows) {
    out.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return out.join("\r\n");
}

type WarHistoryRow = {
  warId: number;
  syncNumber: number | null;
  matchType: "FWA" | "BL" | "MM" | null;
  clanStars: number | null;
  clanDestruction: number | null;
  opponentStars: number | null;
  opponentDestruction: number | null;
  fwaPointsGained: number | null;
  expectedOutcome: string | null;
  actualOutcome: string | null;
  enemyPoints: number | null;
  warStartTime: Date;
  warEndTime: Date | null;
  clanName: string | null;
  clanTag: string;
  opponentName: string | null;
  opponentTag: string | null;
};

export const War: Command = {
  name: "war",
  description: "War history summary and war-id drill-down lookup",
  options: [
    {
      name: "history",
      description: "Show clan-level war history",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Tracked clan tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "limit",
          description: "Number of wars to show (default 10, max 50)",
          type: ApplicationCommandOptionType.Integer,
          required: false,
        },
      ],
    },
    {
      name: "war-id",
      description: "Export stored war attack payload as CSV",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "war-id",
          description: "War ID (from /war history)",
          type: ApplicationCommandOptionType.Integer,
          required: true,
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand(true);

    if (sub === "history") {
      const clanTag = normalizeClanTag(interaction.options.getString("clan-tag", true));
      if (!clanTag) {
        await interaction.editReply("Invalid clan tag.");
        return;
      }
      const requestedLimit = interaction.options.getInteger("limit", false) ?? 10;
      const limit = Math.max(1, Math.min(50, requestedLimit));
      const tagBare = normalizeClanTagInput(clanTag);

      const rows = await prisma.$queryRaw<WarHistoryRow[]>(
        Prisma.sql`
          SELECT
            "warId","syncNumber","matchType","clanStars","clanDestruction","opponentStars","opponentDestruction","fwaPointsGained","expectedOutcome","actualOutcome","enemyPoints","warStartTime","warEndTime","clanName","clanTag","opponentName","opponentTag"
          FROM "WarClanHistory"
          WHERE UPPER(REPLACE("clanTag",'#','')) = ${tagBare}
          ORDER BY "warStartTime" DESC
          LIMIT ${limit}
        `
      );

      if (rows.length === 0) {
        await interaction.editReply(`No war history found for ${clanTag}.`);
        return;
      }

      const displayName = rows[0]?.clanName?.trim() || clanTag;
      const embed = new EmbedBuilder()
        .setTitle(`War History - ${displayName} (${clanTag})`)
        .setDescription(`Showing latest ${rows.length} war(s).`)
        .setColor(0x3498db)
        .setTimestamp(new Date());

      for (const row of rows.slice(0, 10)) {
        const startTs = Math.floor(new Date(row.warStartTime).getTime() / 1000);
        const endTs = row.warEndTime ? Math.floor(new Date(row.warEndTime).getTime() / 1000) : null;
        embed.addFields({
          name: `War #${row.warId} | Sync ${row.syncNumber ?? "unknown"} | ${row.matchType ?? "unknown"}`,
          value: [
            `${displayName} ${row.clanStars ?? "?"} (${formatPercent(row.clanDestruction)}) vs ${row.opponentName ?? "Unknown"} ${row.opponentStars ?? "?"} (${formatPercent(row.opponentDestruction)})`,
            `Expected: ${row.expectedOutcome ?? "UNKNOWN"} | Actual: ${row.actualOutcome ?? "UNKNOWN"}`,
            `Points gained: ${row.fwaPointsGained ?? "unknown"}${row.enemyPoints !== null ? ` | Enemy points: ${row.enemyPoints}` : ""}`,
            `Start: <t:${startTs}:F>${endTs ? ` | End: <t:${endTs}:F>` : ""}`,
          ].join("\n"),
          inline: false,
        });
      }

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "war-id") {
      const warId = interaction.options.getInteger("war-id", true);
      if (!Number.isFinite(warId) || warId <= 0) {
        await interaction.editReply("Invalid war ID.");
        return;
      }

      const rows = await prisma.$queryRaw<Array<{ payload: unknown }>>(
        Prisma.sql`
          SELECT "payload"
          FROM "WarLookup"
          WHERE "warId" = ${warId}
          LIMIT 1
        `
      );
      const payload = rows[0]?.payload ?? null;
      if (!payload) {
        await interaction.editReply(`No lookup payload found for war ID ${warId}.`);
        return;
      }

      let attackRows: Array<Record<string, unknown>> = [];
      if (Array.isArray(payload)) {
        attackRows = payload as Array<Record<string, unknown>>;
      } else if (typeof payload === "string") {
        try {
          const parsed = JSON.parse(payload) as unknown;
          attackRows = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
        } catch {
          attackRows = [];
        }
      }

      if (attackRows.length === 0) {
        await interaction.editReply(`War ${warId} payload is present but has no attack rows.`);
        return;
      }

      const headers = [
        "id",
        "clanTag",
        "clanName",
        "opponentClanTag",
        "opponentClanName",
        "warStartTime",
        "warEndTime",
        "warState",
        "playerTag",
        "playerName",
        "playerPosition",
        "attackOrder",
        "attackNumber",
        "defenderTag",
        "defenderName",
        "defenderPosition",
        "stars",
        "trueStars",
        "destruction",
        "attackSeenAt",
        "updatedAt",
        "createdAt",
      ];

      const csv = buildCsv(attackRows, headers);
      const file = new AttachmentBuilder(Buffer.from(csv, "utf8"), {
        name: `war-${warId}.csv`,
      });

      await interaction.editReply({
        content: `Exported war ${warId} (${attackRows.length} rows).`,
        files: [file],
      });
      return;
    }

    await interaction.editReply("Unknown /war subcommand.");
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
        const tag = normalizeClanTagInput(clan.tag);
        const label = clan.name?.trim() ? `${clan.name.trim()} (#${tag})` : `#${tag}`;
        return { name: label.slice(0, 100), value: tag };
      })
      .filter((c) => c.name.toLowerCase().includes(query) || c.value.toLowerCase().includes(query))
      .slice(0, 25);
    await interaction.respond(choices);
  },
};

