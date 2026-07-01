import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonInteraction,
  type ChatInputCommandInteraction,
  Client,
  ComponentType,
} from "discord.js";
import { normalizeClashTagWithHash } from "../../helper/clashTag";
import { formatError } from "../../helper/formatError";
import { resolveTownHallEmojiMap, type TownHallEmojiMap } from "../../helper/townHallEmoji";
import { prisma } from "../../prisma";
import {
  WarPlanViolationHistoryService,
  type WarPlanViolationHistoryAllianceOverview,
  type WarPlanViolationHistoryClanLeaderboardResult,
  type WarPlanViolationHistoryDiscordUserAggregateResult,
  type WarPlanViolationHistoryPeriod,
  type WarPlanViolationHistoryPlayerHistoryResult,
} from "../../services/WarPlanViolationHistoryService";
import type { CoCService } from "../../services/CoCService";
import {
  buildWarPlanViolationsAllianceOverviewEmbed,
  buildWarPlanViolationsClanLeaderboardEmbed,
  buildWarPlanViolationsDiscordUserAggregateEmbed,
  buildWarPlanViolationsPlayerHistoryEmbed,
  buildWarPlanViolationsPlayerHistoryPaginationRow,
} from "./violationsView";

export const FWA_VIOLATIONS_SUBCOMMAND = {
  name: "violations",
  description: "Show persisted war-plan violation history",
  type: ApplicationCommandOptionType.Subcommand,
  options: [
    {
      name: "period",
      description: "Reporting period",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: [
        { name: "Last 30 days", value: "30d" },
        { name: "Lifetime", value: "lifetime" },
      ],
    },
    {
      name: "clan",
      description: "Tracked clan tag (with or without #)",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: true,
    },
    {
      name: "player",
      description: "Player tag (with or without #)",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: true,
    },
    {
      name: "discord-user",
      description: "Discord user to aggregate",
      type: ApplicationCommandOptionType.User,
      required: false,
    },
    {
      name: "visibility",
      description: "Response visibility",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: [
        { name: "private", value: "private" },
        { name: "public", value: "public" },
      ],
    },
  ],
} as const;

const DEFAULT_PAGINATION_TIMEOUT_MS = 10 * 60 * 1000;
const NO_ALLOWED_MENTIONS = { parse: [] as [] };
const COMBINATION_VALIDATION_ERROR =
  "Player history cannot currently be filtered by clan.\n" +
  "Choose either player or discord-user, not both.\n" +
  "Clan may be used alone or with discord-user.";

type FwaViolationsClanAutocompleteChoice = {
  name: string;
  value: string;
};

export type FwaViolationsCommandDeps = {
  historyService?: WarPlanViolationHistoryService;
  resolveTownHallEmojiMap?: (client: Client) => Promise<TownHallEmojiMap>;
  loadTrackedClanAutocompleteChoices?: (
    query: string,
  ) => Promise<FwaViolationsClanAutocompleteChoice[]>;
  paginatorTimeoutMs?: number;
};

const defaultHistoryService = new WarPlanViolationHistoryService();

async function defaultLoadTrackedClanAutocompleteChoices(
  query: string,
): Promise<FwaViolationsClanAutocompleteChoice[]> {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  const tracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { name: true, tag: true },
  });

  return tracked
    .map((row) => {
      const normalizedTag = normalizeClashTagWithHash(row.tag);
      if (!normalizedTag) return null;
      const displayName = String(row.name ?? "").trim();
      const label = displayName ? `${displayName} (${normalizedTag})` : normalizedTag;
      return {
        name: label.slice(0, 100),
        value: normalizedTag,
      };
    })
    .filter((choice): choice is FwaViolationsClanAutocompleteChoice => Boolean(choice))
    .filter((choice) => {
      if (!normalizedQuery) return true;
      const normalizedValue = choice.value.toLowerCase();
      const normalizedBareValue = choice.value.replace(/^#/, "").toLowerCase();
      const normalizedName = choice.name.toLowerCase();
      return (
        normalizedName.includes(normalizedQuery) ||
        normalizedValue.includes(normalizedQuery) ||
        normalizedBareValue.includes(normalizedQuery)
      );
    })
    .slice(0, 25);
}

function normalizeViolationsPeriod(
  input: string | null | undefined,
): WarPlanViolationHistoryPeriod {
  return input === "lifetime" ? "lifetime" : "30d";
}

function isPublicVisibility(input: string | null | undefined): boolean {
  return String(input ?? "").trim().toLowerCase() === "public";
}

function buildValidationReply(message: string): {
  content: string;
  ephemeral: true;
  allowedMentions: typeof NO_ALLOWED_MENTIONS;
} {
  return {
    content: message,
    ephemeral: true,
    allowedMentions: NO_ALLOWED_MENTIONS,
  };
}

function getViolationsService(deps?: FwaViolationsCommandDeps): WarPlanViolationHistoryService {
  return deps?.historyService ?? defaultHistoryService;
}

function getTownHallEmojiResolver(
  deps?: FwaViolationsCommandDeps,
): (client: Client) => Promise<TownHallEmojiMap> {
  return deps?.resolveTownHallEmojiMap ?? resolveTownHallEmojiMap;
}

function getCollectorTimeoutMs(deps?: FwaViolationsCommandDeps): number {
  const value = Math.trunc(Number(deps?.paginatorTimeoutMs ?? DEFAULT_PAGINATION_TIMEOUT_MS));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PAGINATION_TIMEOUT_MS;
}

function resolveCommandRoute(input: {
  clanTag: string | null;
  playerTag: string | null;
  discordUserId: string | null;
}):
  | { type: "overview" }
  | { type: "clan"; clanTag: string }
  | { type: "player"; playerTag: string }
  | { type: "discord-user"; clanTag: string | null; discordUserId: string } {
  if (input.playerTag) {
    return { type: "player", playerTag: input.playerTag };
  }
  if (input.discordUserId) {
    return {
      type: "discord-user",
      clanTag: input.clanTag,
      discordUserId: input.discordUserId,
    };
  }
  if (input.clanTag) {
    return { type: "clan", clanTag: input.clanTag };
  }
  return { type: "overview" };
}

function formatCommonFailureMessage(error: unknown): string {
  void error;
  return "Failed to display war plan violations. Please try again.";
}

async function buildViolationsEmbed(input: {
  route:
    | { type: "overview" }
    | { type: "clan"; clanTag: string }
    | { type: "player"; playerTag: string }
    | { type: "discord-user"; clanTag: string | null; discordUserId: string };
  period: WarPlanViolationHistoryPeriod;
  guildId: string;
  historyService: WarPlanViolationHistoryService;
  townHallIconSource: TownHallEmojiMap;
}): Promise<
  | {
      embed:
        | ReturnType<typeof buildWarPlanViolationsAllianceOverviewEmbed>
        | ReturnType<typeof buildWarPlanViolationsClanLeaderboardEmbed>
        | ReturnType<typeof buildWarPlanViolationsDiscordUserAggregateEmbed>
        | ReturnType<typeof buildWarPlanViolationsPlayerHistoryEmbed>;
      result:
        | WarPlanViolationHistoryAllianceOverview
        | WarPlanViolationHistoryClanLeaderboardResult
        | WarPlanViolationHistoryDiscordUserAggregateResult
        | WarPlanViolationHistoryPlayerHistoryResult;
    }
  | null
> {
  switch (input.route.type) {
    case "overview": {
      const result = await input.historyService.getAllianceOverview({
        guildId: input.guildId,
        period: input.period,
      });
      return {
        result,
        embed: buildWarPlanViolationsAllianceOverviewEmbed({
          result,
          townHallIconSource: input.townHallIconSource,
        }),
      };
    }
    case "clan": {
      const result = await input.historyService.getClanLeaderboard({
        guildId: input.guildId,
        clanTag: input.route.clanTag,
        period: input.period,
      });
      return {
        result,
        embed: buildWarPlanViolationsClanLeaderboardEmbed({
          result,
          townHallIconSource: input.townHallIconSource,
        }),
      };
    }
    case "player": {
      const result = await input.historyService.getPlayerHistory({
        guildId: input.guildId,
        playerTag: input.route.playerTag,
        period: input.period,
      });
      return {
        result,
        embed: buildWarPlanViolationsPlayerHistoryEmbed({
          result,
          page: 0,
          townHallIconSource: input.townHallIconSource,
        }),
      };
    }
    case "discord-user": {
      const result = await input.historyService.getDiscordUserAggregate({
        guildId: input.guildId,
        discordUserId: input.route.discordUserId,
        period: input.period,
        clanTag: input.route.clanTag,
      });
      return {
        result,
        embed: buildWarPlanViolationsDiscordUserAggregateEmbed({
          result,
          townHallIconSource: input.townHallIconSource,
        }),
      };
    }
  }
  return null;
}

export async function runFwaViolationsCommand(
  interaction: ChatInputCommandInteraction,
  _cocService: CoCService,
  deps?: FwaViolationsCommandDeps,
): Promise<void> {
  void _cocService;
  const guildId = String(interaction.guildId ?? "").trim();
  const period = normalizeViolationsPeriod(
    interaction.options.getString("period", false),
  );
  const visibility = isPublicVisibility(
    interaction.options.getString("visibility", false),
  )
    ? "public"
    : "private";
  const clanRaw = interaction.options.getString("clan", false);
  const playerRaw = interaction.options.getString("player", false);
  const discordUser = interaction.options.getUser("discord-user", false);
  const hasClanOption = clanRaw !== null && clanRaw !== undefined && String(clanRaw).trim() !== "";
  const hasPlayerOption = playerRaw !== null && playerRaw !== undefined && String(playerRaw).trim() !== "";
  const hasDiscordUserOption = Boolean(discordUser?.id);
  const normalizedClanTag =
    !hasClanOption
      ? null
      : normalizeClashTagWithHash(clanRaw);
  const normalizedPlayerTag =
    !hasPlayerOption
      ? null
      : normalizeClashTagWithHash(playerRaw);
  const normalizedDiscordUserId = discordUser?.id ? String(discordUser.id).trim() : null;

  if (!guildId) {
    await interaction.reply(
      buildValidationReply("This command can only be used in a server."),
    );
    return;
  }

  if ((hasPlayerOption && hasClanOption) || (hasPlayerOption && hasDiscordUserOption)) {
    await interaction.reply(buildValidationReply(COMBINATION_VALIDATION_ERROR));
    return;
  }

  if (clanRaw && !normalizedClanTag) {
    await interaction.reply(buildValidationReply("Please provide a valid `clan` tag."));
    return;
  }

  if (playerRaw && !normalizedPlayerTag) {
    await interaction.reply(buildValidationReply("Please provide a valid `player` tag."));
    return;
  }

  const route = resolveCommandRoute({
    clanTag: normalizedClanTag,
    playerTag: normalizedPlayerTag,
    discordUserId: normalizedDiscordUserId,
  });

  const historyService = getViolationsService(deps);
  const resolveEmojiMap = getTownHallEmojiResolver(deps);
  const paginatorTimeoutMs = getCollectorTimeoutMs(deps);

  try {
    await interaction.deferReply({ ephemeral: visibility !== "public" });
    const townHallIconSource = await resolveEmojiMap(interaction.client);

    const result = await buildViolationsEmbed({
      route,
      period,
      guildId,
      historyService,
      townHallIconSource,
    });

    if (!result) {
      await interaction.editReply({
        content: undefined,
        embeds: [],
        components: [],
        allowedMentions: NO_ALLOWED_MENTIONS,
      });
      return;
    }

    if (route.type === "player") {
      const playerResult = result.result as WarPlanViolationHistoryPlayerHistoryResult;
      if (playerResult.outcome === "success" && playerResult.entries.length > 1) {
        const previousCustomId = `fwa:violations:${interaction.id}:previous`;
        const nextCustomId = `fwa:violations:${interaction.id}:next`;
        let currentPage = 0;
        const totalPages = playerResult.entries.length;
        const initialRow = buildWarPlanViolationsPlayerHistoryPaginationRow({
          previousCustomId,
          nextCustomId,
          currentPage,
          totalPages,
        });
        const message = await interaction.editReply({
          embeds: [result.embed],
          components: initialRow ? [initialRow] : [],
          allowedMentions: NO_ALLOWED_MENTIONS,
        });
        const collector = (message as unknown as {
          createMessageComponentCollector?: (options: Record<string, unknown>) => {
            on: (event: "collect" | "end", handler: (...args: any[]) => Promise<void> | void) => void;
          };
        }).createMessageComponentCollector?.({
          componentType: ComponentType.Button,
          time: paginatorTimeoutMs,
        });
        if (!collector) {
          return;
        }

        collector.on("collect", async (button: ButtonInteraction) => {
          if (button.user.id !== interaction.user.id) {
            await button
              .reply({
                ephemeral: true,
                content: "Only the command user can control this paginator.",
                allowedMentions: NO_ALLOWED_MENTIONS,
              })
              .catch(() => undefined);
            return;
          }
          if (button.customId === previousCustomId) {
            currentPage = Math.max(0, currentPage - 1);
          } else if (button.customId === nextCustomId) {
            currentPage = Math.min(totalPages - 1, currentPage + 1);
          } else {
            return;
          }

          const paginationRow = buildWarPlanViolationsPlayerHistoryPaginationRow({
            previousCustomId,
            nextCustomId,
            currentPage,
            totalPages,
          });
          const pageEmbed = buildWarPlanViolationsPlayerHistoryEmbed({
            result: playerResult,
            page: currentPage,
            townHallIconSource,
          });
          await button
            .update({
              embeds: [pageEmbed],
              components: paginationRow ? [paginationRow] : [],
              allowedMentions: NO_ALLOWED_MENTIONS,
            })
            .catch(() => undefined);
        });

        collector.on("end", async () => {
          const disabledRow = buildWarPlanViolationsPlayerHistoryPaginationRow({
            previousCustomId,
            nextCustomId,
            currentPage,
            totalPages,
            disabled: true,
          });
          await interaction
            .editReply({
              embeds: [
                buildWarPlanViolationsPlayerHistoryEmbed({
                  result: playerResult,
                  page: currentPage,
                  townHallIconSource,
                }),
              ],
              components: disabledRow ? [disabledRow] : [],
              allowedMentions: NO_ALLOWED_MENTIONS,
            })
            .catch(() => undefined);
        });
        return;
      }
    }

    await interaction.editReply({
      embeds: [result.embed],
      components: [],
      allowedMentions: NO_ALLOWED_MENTIONS,
    });
  } catch (error) {
    console.error(
      `[fwa violations] event=failed command=fwa subcommand=violations guild=${interaction.guildId ?? "dm"} user=${interaction.user.id} error=${formatError(error)}`,
    );
    if (interaction.deferred || interaction.replied) {
      await interaction
        .editReply({
          content: formatCommonFailureMessage(error),
          embeds: [],
          components: [],
          allowedMentions: NO_ALLOWED_MENTIONS,
        })
        .catch(() => undefined);
      return;
    }
    await interaction
      .reply({
        content: formatCommonFailureMessage(error),
        ephemeral: true,
        allowedMentions: NO_ALLOWED_MENTIONS,
      })
      .catch(() => undefined);
  }
}

export async function buildFwaViolationsClanAutocompleteChoices(input: {
  focusedText?: string | null;
  limit?: number;
  loadChoices?: (query: string) => Promise<FwaViolationsClanAutocompleteChoice[]>;
}): Promise<FwaViolationsClanAutocompleteChoice[]> {
  const loader = input.loadChoices ?? defaultLoadTrackedClanAutocompleteChoices;
  const choices = await loader(String(input.focusedText ?? ""));
  const rawLimit = Number(input.limit ?? 25);
  const normalizedLimit = Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 25;
  const limit = Math.max(1, Math.min(25, normalizedLimit));
  return choices.slice(0, limit);
}

export async function buildFwaViolationsPlayerAutocompleteChoices(input: {
  guildId: string | null | undefined;
  focusedText?: string | null;
  limit?: number;
  historyService?: WarPlanViolationHistoryService;
}): Promise<Array<{ name: string; value: string }>> {
  const service = getViolationsService({ historyService: input.historyService });
  return service.getPlayerAutocompleteChoices({
    guildId: String(input.guildId ?? ""),
    focusedText: input.focusedText ?? "",
    limit: input.limit ?? 25,
  });
}

export async function autocompleteFwaViolationsCommand(
  interaction: AutocompleteInteraction,
  deps?: FwaViolationsCommandDeps,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  try {
    if (focused.name === "player") {
      const choices = await buildFwaViolationsPlayerAutocompleteChoices({
        guildId: interaction.guildId ?? "",
        focusedText: String(focused.value ?? ""),
        limit: 25,
        historyService: deps?.historyService,
      });
      await interaction.respond(choices);
      return;
    }

    if (focused.name === "clan") {
      const choices = await buildFwaViolationsClanAutocompleteChoices({
        focusedText: String(focused.value ?? ""),
        limit: 25,
        loadChoices: deps?.loadTrackedClanAutocompleteChoices,
      });
      await interaction.respond(choices);
      return;
    }

    await interaction.respond([]);
  } catch {
    await interaction.respond([]).catch(() => undefined);
  }
}
