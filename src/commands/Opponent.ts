import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { SettingsService } from "../services/SettingsService";
import { formatError } from "../helper/formatError";
import { getPointsSnapshotForClan } from "./Fwa";

function normalizeClanTag(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function deriveWarState(rawState: string | null | undefined): "preparation" | "inWar" | "notInWar" {
  const state = String(rawState ?? "").toLowerCase();
  if (state.includes("preparation")) return "preparation";
  if (state.includes("inwar")) return "inWar";
  return "notInWar";
}

function formatWarStateLabel(warState: "preparation" | "inWar" | "notInWar"): string {
  if (warState === "preparation") return "preparation";
  if (warState === "inWar") return "battle day";
  return "no war";
}

function getSyncDisplay(
  previousSync: number | null,
  warState: "preparation" | "inWar" | "notInWar"
): string {
  if (previousSync === null) return "unknown";
  const current = previousSync + 1;
  if (warState === "notInWar") return `between #${previousSync} and #${current}`;
  return `#${current}`;
}

export const Opponent: Command = {
  name: "opponent",
  description: "Get current war opponent clan tag for a clan",
  options: [
    {
      name: "tag",
      description: "Your clan tag (with or without #)",
      type: ApplicationCommandOptionType.String,
      required: true,
      autocomplete: true,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });

    const rawTag = interaction.options.getString("tag", true);
    const clanTag = normalizeClanTag(rawTag);
    if (!clanTag) {
      await interaction.editReply("Please provide a valid clan tag.");
      return;
    }

    try {
      const settings = new SettingsService();
      const war = await cocService.getCurrentWar(clanTag);
      const warState = deriveWarState(war?.state);
      const syncFromSetting = await settings
        .get("previousSyncNum")
        .then((raw) => {
          if (!raw) return null;
          const value = Number(raw);
          return Number.isFinite(value) ? Math.trunc(value) : null;
        })
        .catch(() => null);
      const syncDisplay = getSyncDisplay(syncFromSetting, warState);
      const opponentTagRaw = String(war?.opponent?.tag ?? "").trim();
      if (!opponentTagRaw) {
        await interaction.editReply(
          `No active war opponent found for ${clanTag}.\nWar state: ${formatWarStateLabel(
            warState
          )}\nSync: ${syncDisplay}`
        );
        return;
      }

      const clanName = String(war?.clan?.name ?? clanTag).trim() || clanTag;
      const opponentName = String(war?.opponent?.name ?? "Unknown").trim() || "Unknown";
      const opponentTag = opponentTagRaw.replace(/^#/, "").toUpperCase();
      const syncFromPoints = await getPointsSnapshotForClan(cocService, clanTag).catch(() => null);
      const fallbackSync = syncFromPoints?.effectiveSync ?? null;
      const syncLine = `\n## War State: \`${formatWarStateLabel(
        warState
      )}\`\n## Sync: \`${syncDisplay === "unknown" && fallbackSync !== null ? `#${fallbackSync}` : syncDisplay}\``;
      await interaction.editReply(
        `## ${clanName} vs\n\n## Opponent: \`${opponentName}\`\n---\n## Opponent Tag: \`${opponentTag}\`${syncLine}`
      );
    } catch (err) {
      console.error(
        `[opponent] failed tag=${clanTag} error=${formatError(err)}`
      );
      await interaction.editReply(
        "Failed to fetch opponent tag from CoC API. Try again shortly."
      );
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "tag") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "").trim().toLowerCase();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = tracked
      .map((c) => {
        const normalized = normalizeClanTag(c.tag).replace(/^#/, "");
        const label = c.name?.trim() ? `${c.name.trim()} (#${normalized})` : `#${normalized}`;
        return { name: label.slice(0, 100), value: normalized };
      })
      .filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.value.toLowerCase().includes(query)
      )
      .slice(0, 25);

    await interaction.respond(choices);
  },
};
