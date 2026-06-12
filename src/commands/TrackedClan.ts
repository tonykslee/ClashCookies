import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { buildClanProfileMarkdownLink } from "../helper/clanProfileLink";
import { safeReply } from "../helper/safeReply";
import { prisma } from "../prisma";
import { ActivityService } from "../services/ActivityService";
import { CoCService } from "../services/CoCService";
import { runWithCoCQueueContext } from "../services/CoCQueueContext";
import { normalizeClanTag } from "../services/PlayerLinkService";
import { FwaClanMembersSyncService } from "../services/fwa-feeds/FwaClanMembersSyncService";
import {
  addCwlClanTagsForSeason,
  ensureAndHydrateCwlTrackedClanMetadataForSeason,
  listCwlTrackedClansForSeason,
  removeTrackedClanTagFromRegistries,
  resolveCurrentCwlSeasonKey,
  type TrackedClanRegistryType,
} from "../services/CwlRegistryService";
import {
  buildRaidTrackedClanListLines,
  getRaidTrackedClanJoinTypeEmoji,
  listRaidTrackedClansForDisplay,
  parseRaidTrackedClanTagsInput,
  normalizeRaidTrackedClanTag,
  refreshRaidTrackedClansMetadata,
  upsertRaidTrackedClansForTags,
} from "../services/RaidTrackedClanService";
import {
  buildFwaTrackedClanMinimalListRender,
  listFwaClanMemberCountsForTags,
  listFwaTrackedClansForDisplay,
  loadFwaTrackedClanMinimalListState,
  listCwlTrackedClansForDetailedDisplay,
  formatCwlLeagueAbbreviation,
  resolveCwlTrackedClanEmojiTokens,
  refreshCwlTrackedClanDetailedDisplayWithQueueContext,
  formatCwlLeagueEmojiResolved,
  formatCwlSpinStatusEmojiResolved,
  type CwlTrackedClanEmojiTokens,
  type CwlTrackedClanDetailedDisplayRow,
} from "../services/TrackedClanListService";

const CUSTOM_EMOJI_PATTERN = /^<(a?):([A-Za-z0-9_]+):(\d+)>$/;
const SHORTCODE_EMOJI_PATTERN = /^:([A-Za-z0-9_]+):$/;

function normalizeClanShortNameInput(input: string): string | null {
  const normalized = input.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function paginateTextLines(lines: string[]): string[] {
  const pages: string[] = [];
  const maxChars = 3900;
  let current: string[] = [];
  let currentLength = 0;

  for (const line of lines) {
    const nextLength = currentLength + (current.length > 0 ? 1 : 0) + line.length;
    if (current.length > 0 && nextLength > maxChars) {
      pages.push(current.join("\n"));
      current = [line];
      currentLength = line.length;
      continue;
    }

    current.push(line);
    currentLength = nextLength;
  }

  if (current.length > 0) {
    pages.push(current.join("\n"));
  }

  return pages;
}

function buildTrackedClanBlock(clan: {
  name: string | null;
  tag: string;
  loseStyle: string;
  mailChannelId: string | null;
  logChannelId: string | null;
  leaderChannelId: string | null;
  clanRoleId: string | null;
  leadRoleId: string | null;
  clanBadge: string | null;
  shortName: string | null;
}): string {
  const title = buildClanProfileMarkdownLink(clan.name, clan.tag);
  const clanTag = normalizeClanTag(clan.tag);
  const label = clan.name && clanTag ? `**${title}** \`${clanTag}\`` : `**${title}**`;
  const mailChannel = clan.mailChannelId ? `<#${clan.mailChannelId}>` : "not set";
  const logChannel = clan.logChannelId ? `<#${clan.logChannelId}>` : "not set";
  const leaderChannel = clan.leaderChannelId ? `<#${clan.leaderChannelId}>` : "not set";
  const clanRole = clan.clanRoleId ? `<@&${clan.clanRoleId}>` : "not set";
  const leadRole = clan.leadRoleId ? `<@&${clan.leadRoleId}>` : "not set";
  const clanBadge = clan.clanBadge ?? "not set";
  const shortName = clan.shortName ?? "not set";
  return [
    label,
    `shortName: ${shortName}`,
    `lose-style: ${clan.loseStyle}`,
    `mailChannel: ${mailChannel}`,
    `logChannel: ${logChannel}`,
    `leaderChannel: ${leaderChannel}`,
    `clanRole: ${clanRole}`,
    `leadRole: ${leadRole}`,
    `clanBadge: ${clanBadge}`,
  ].join("\n");
}

function buildRosterTitleMarkdownLink(title: string | null, url: string | null): string {
  const normalizedTitle = String(title ?? "").replace(/\s+/g, " ").trim();
  if (!normalizedTitle) return "Roster";
  const normalizedUrl = String(url ?? "").trim();
  if (!normalizedUrl) return normalizedTitle;
  return `[${normalizedTitle}](<${normalizedUrl}>)`;
}

function buildCwlTrackedClanBlock(
  clan: CwlTrackedClanDetailedDisplayRow,
  emojiTokens: CwlTrackedClanEmojiTokens,
): string {
  const title = buildClanProfileMarkdownLink(clan.name, clan.tag);
  const clanTag = normalizeClanTag(clan.tag);
  const leagueEmoji = formatCwlLeagueEmojiResolved(clan.leagueLabel, emojiTokens) ?? "-";
  const label = clan.name && clanTag ? `**${title}** \`${clanTag}\` ${leagueEmoji}` : `**${title}** ${leagueEmoji}`;
  const rosterText = clan.rosterTitle
    ? buildRosterTitleMarkdownLink(clan.rosterTitle, clan.rosterPostedMessageUrl)
    : "none";
  const currentClanMemberCount = clan.currentClanMemberCount === null ? "—" : String(clan.currentClanMemberCount);
  return [
    label,
    `Spin status: ${formatCwlSpinStatusEmojiResolved(clan.spinStatus, emojiTokens)}`,
    `Members: ${clan.observedCwlRosterCount} CWL / ${currentClanMemberCount} clan`,
    `Roster: ${rosterText}`,
  ].join("\n");
}

function buildCwlTrackedClanMinimalLine(
  clan: CwlTrackedClanDetailedDisplayRow & { currentClanMemberCount: number | null },
  emojiTokens: CwlTrackedClanEmojiTokens,
): string {
  const title = buildClanProfileMarkdownLink(clan.name, clan.tag);
  const clanTag = normalizeClanTag(clan.tag);
  const leagueEmoji = formatCwlLeagueEmojiResolved(clan.leagueLabel, emojiTokens) ?? "-";
  const leagueAbbreviation = formatCwlLeagueAbbreviation(clan.leagueLabel);
  const spinEmoji = formatCwlSpinStatusEmojiResolved(clan.spinStatus, emojiTokens);
  const memberCountText = formatTrackedClanMemberCount(clan.currentClanMemberCount);
  const prefix = `${leagueEmoji} ${leagueAbbreviation}`;
  return clan.name && clanTag
    ? `${prefix} | ${title} \`${clanTag}\` | ${spinEmoji} | ${memberCountText}`
    : `${prefix} | ${title} | ${spinEmoji} | ${memberCountText}`;
}

function buildCwlTrackedClanListComponents(
  prefix: string,
  page: number,
  totalPages: number,
  refreshing: boolean,
  paginated: boolean,
) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (paginated && totalPages > 1) {
    rows.push(buildTrackedClanListRow(prefix, page, totalPages, refreshing));
  }
  rows.push(buildTrackedClanSummaryRefreshRow(prefix, refreshing));
  return rows;
}

function paginateTrackedClanBlocks(blocks: string[]): string[] {
  const pages: string[] = [];
  const maxChars = 3900;
  let current = "";

  for (const block of blocks) {
    if (current.length === 0) {
      current = block;
      continue;
    }

    const candidate = `${current}\n\n${block}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    pages.push(current);
    current = block;
  }

  if (current.length > 0) {
    pages.push(current);
  }

  return pages;
}

function buildTrackedClanListEmbed(total: number, pageContent: string, page: number, pages: number) {
  return new EmbedBuilder()
    .setTitle(`Tracked Clans (${total})`)
    .setDescription(pageContent)
    .setColor(0x57f287)
    .setFooter({ text: `Page ${page + 1}/${pages}` });
}

function buildTrackedClanSectionEmbed(title: string, total: number, description: string) {
  return new EmbedBuilder()
    .setTitle(`Tracked Clans (${title}) (${total})`)
    .setDescription(description)
    .setColor(0x57f287);
}

function buildCwlTrackedClanListEmbed(
  total: number,
  season: string,
  pageContent: string,
  page: number,
  pages: number
) {
  return new EmbedBuilder()
    .setTitle(`Tracked Clans (CWL ${season}) (${total})`)
    .setDescription(pageContent)
    .setColor(0xfee75c)
    .setFooter({ text: `Page ${page + 1}/${pages}` });
}

function buildCwlTrackedClanSeamlessEmbeds(total: number, season: string, pageContents: string[]): EmbedBuilder[] {
  return pageContents.map((pageContent, index) => {
    const embed = new EmbedBuilder()
      .setDescription(pageContent)
      .setColor(0xfee75c);
    if (index === 0) {
      embed.setTitle(`Tracked Clans (CWL ${season}) (${total})`);
    }
    return embed;
  });
}

function buildRaidTrackedClanListEmbed(
  total: number,
  pageContent: string,
  page: number,
  pages: number,
) {
  return new EmbedBuilder()
    .setTitle(`Tracked Clans (RAIDS) (${total})`)
    .setDescription(pageContent)
    .setColor(0x5865f2)
    .setFooter({ text: `Page ${page + 1}/${pages}` });
}

function buildTrackedClanListRow(
  prefix: string,
  page: number,
  totalPages: number,
  disabled = false,
) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:prev`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page <= 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}:next`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page >= totalPages - 1)
  );
}

function buildRaidTrackedClanRefreshRow(prefix: string, refreshing: boolean) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:refresh`)
      .setEmoji("🔄")
      .setLabel(refreshing ? "Refreshing..." : "Refresh")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(refreshing),
  );
}

function buildRaidTrackedClanListComponents(
  prefix: string,
  page: number,
  totalPages: number,
  refreshing: boolean,
) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (totalPages > 1) {
    rows.push(buildTrackedClanListRow(prefix, page, totalPages, refreshing));
  }
  rows.push(buildRaidTrackedClanRefreshRow(prefix, refreshing));
  return rows;
}

function buildTrackedClanSummaryRefreshRow(prefix: string, refreshing: boolean) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:refresh`)
      .setEmoji("🔄")
      .setLabel(refreshing ? "Refreshing..." : "Refresh")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(refreshing),
  );
}

function buildTrackedClanSummaryRefreshComponents(prefix: string, refreshing: boolean) {
  return [buildTrackedClanSummaryRefreshRow(prefix, refreshing)];
}

function formatTrackedClanMemberCount(memberCount: number | null): string {
  return memberCount === null ? "\u2014 👥" : `${memberCount} 👥`;
}

function buildTrackedClanSummaryLine(clan: {
  name: string | null;
  tag: string;
  memberCount: number | null;
}): string {
  const title = buildClanProfileMarkdownLink(clan.name, clan.tag);
  const clanTag = normalizeClanTag(clan.tag);
  const memberCountText = formatTrackedClanMemberCount(clan.memberCount);
  return clan.name && clanTag
    ? `- ${title} \`${clanTag}\` | ${memberCountText}`
    : `- ${title} | ${memberCountText}`;
}

function buildRaidTrackedClanSummaryLine(clan: {
  clanTag: string;
  clanName: string | null;
  upgrades: number | null;
  joinType: "open" | "inviteOnly" | "closed" | null;
  memberCount: number | null;
}): string {
  const clanTag = normalizeRaidTrackedClanTag(clan.clanTag) || clan.clanTag;
  const upgradesText = clan.upgrades === null ? "\u2014" : String(clan.upgrades);
  const emoji = getRaidTrackedClanJoinTypeEmoji(clan.joinType);
  const title = buildClanProfileMarkdownLink(
    `${clan.clanName ?? clanTag} | ${upgradesText}`,
    clan.clanTag,
  );
  return `- ${emoji} ${title} \`${clanTag}\` | ${formatTrackedClanMemberCount(clan.memberCount)}`;
}

function buildCombinedTrackedClanListDescription(sections: Array<{ title: string; lines: string[] }>) {
  return sections.map((section) => [`**${section.title}**`, ...section.lines].join("\n")).join("\n\n");
}

function buildCombinedTrackedClanListEmbed(total: number, description: string) {
  return new EmbedBuilder()
    .setTitle(`Tracked Clans (All Types) (${total})`)
    .setDescription(description)
    .setColor(0x57f287);
}

function formatTagListForSummary(tags: string[]): string {
  if (tags.length <= 0) return "none";
  return tags.join(", ");
}

type TrackedClanSummaryRefreshRenderer = (input: {
  memberCountByTag: Map<string, number>;
  refreshing: boolean;
}) => {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
};

const fwaClanMembersSyncService = new FwaClanMembersSyncService();

async function refreshTrackedClanSummaryView(params: {
  button: ButtonInteraction;
  interaction: ChatInputCommandInteraction;
  cocService: CoCService;
  viewName: string;
  displayedClanTags: string[];
  currentMemberCounts: Map<string, number>;
  render: TrackedClanSummaryRefreshRenderer;
}): Promise<{ refreshedMemberCounts: Map<string, number> }> {
  const refreshTags = [...new Set(params.displayedClanTags)];
  let currentMemberCounts = params.currentMemberCounts;

  try {
    await params.button.update(params.render({ memberCountByTag: currentMemberCounts, refreshing: true }));
  } catch (error) {
    console.error(
      `[tracked-clan] stage=list_member_counts_refresh_update_failed command=list view=${params.viewName} displayed_count=${refreshTags.length} error=${formatError(error)}`,
    );
    if (!params.button.replied && !params.button.deferred) {
      try {
        await params.button.deferUpdate();
      } catch {
        // no-op
      }
    }
  }

  try {
    const refreshResult = await runWithCoCQueueContext(
      {
        priority: "interactive",
        source: `tracked-clan:list:member-counts-refresh:${params.viewName}`,
      },
      () =>
        fwaClanMembersSyncService.refreshCurrentClanMembersForClanTags(refreshTags, {
          cocService: params.cocService,
        }),
    );
    currentMemberCounts = await listFwaClanMemberCountsForTags(refreshTags);

    if (refreshResult.failedClans.length > 0) {
      console.error(
        `[tracked-clan] stage=list_member_counts_refresh command=list view=${params.viewName} status=${
          refreshResult.failedClans.length >= refreshTags.length ? "FAILURE" : "PARTIAL"
        } displayed_count=${refreshTags.length} failed_tags=${formatTagListForSummary(refreshResult.failedClans)}`,
      );
    }

    await params.interaction.editReply(
      params.render({ memberCountByTag: currentMemberCounts, refreshing: false }),
    );

    if (refreshResult.failedClans.length > 0) {
      const failedMessage =
        refreshResult.failedClans.length >= refreshTags.length
          ? "Failed to refresh member counts for the displayed clans."
          : `Failed to refresh some clan member counts: ${formatTagListForSummary(refreshResult.failedClans)}`;
      await params.button.followUp({
        ephemeral: true,
        content: failedMessage,
      });
    }
  } catch (error) {
    console.error(
      `[tracked-clan] stage=list_member_counts_refresh command=list view=${params.viewName} status=FAILURE displayed_count=${refreshTags.length} error=${formatError(error)}`,
    );
    await params.interaction.editReply(
      params.render({ memberCountByTag: currentMemberCounts, refreshing: false }),
    );
    await params.button.followUp({
      ephemeral: true,
      content: "Failed to refresh member counts for the displayed clans.",
    });
  }

  return { refreshedMemberCounts: currentMemberCounts };
}

export async function refreshRaidTrackedClanListWithQueueContext(input: {
  cocService: CoCService;
}): Promise<Awaited<ReturnType<typeof refreshRaidTrackedClansMetadata>>> {
  return runWithCoCQueueContext(
    {
      priority: "interactive",
      source: "tracked-clan:list:raids:refresh",
    },
    () => refreshRaidTrackedClansMetadata({ cocService: input.cocService }),
  );
}

async function normalizeClanBadgeInput(
  interaction: ChatInputCommandInteraction,
  input: string
): Promise<string | null> {
  const value = input.trim();
  if (!value) return null;

  const customMatch = value.match(CUSTOM_EMOJI_PATTERN);
  if (customMatch) {
    const animated = customMatch[1] === "a";
    const name = customMatch[2];
    const id = customMatch[3];
    return `<${animated ? "a" : ""}:${name}:${id}>`;
  }

  const shortcodeMatch = value.match(SHORTCODE_EMOJI_PATTERN);
  if (shortcodeMatch) {
    const guild = interaction.guild;
    if (!guild) {
      throw new Error("CLAN_BADGE_GUILD_REQUIRED");
    }

    const shortcodeName = shortcodeMatch[1];
    let emoji = guild.emojis.cache.find((e) => e.name === shortcodeName);
    if (!emoji) {
      await guild.emojis.fetch();
      emoji = guild.emojis.cache.find((e) => e.name === shortcodeName);
    }
    if (!emoji) {
      throw new Error("CLAN_BADGE_SHORTCODE_NOT_FOUND");
    }

    return `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
  }

  return value;
}

export const TrackedClan: Command = {
  name: "clan",
  description: "Configure, remove, or list tracked clans",
  options: [
    {
      name: "configure",
      description: "Add or update a tracked clan configuration",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Clan tag (example: #2QG2C08UP)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "lose-style",
          description: "FWA lose-war plan style for this clan",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "Triple-top-30", value: "TRIPLE_TOP_30" },
            { name: "Traditional", value: "TRADITIONAL" },
          ],
        },
        {
          name: "mail-channel",
          description: "Discord channel to receive tracked clan war mail",
          type: ApplicationCommandOptionType.Channel,
          required: false,
        },
        {
          name: "log-channel",
          description: "Discord channel for tracked clan logs",
          type: ApplicationCommandOptionType.Channel,
          required: false,
        },
        {
          name: "leader-channel",
          description: "Discord channel for tracked clan leader updates",
          type: ApplicationCommandOptionType.Channel,
          required: false,
        },
        {
          name: "clan-role",
          description: "Discord role associated with this tracked clan",
          type: ApplicationCommandOptionType.Role,
          required: false,
        },
        {
          name: "lead-role",
          description: "Discord role automatically assigned to tracked clan leaders",
          type: ApplicationCommandOptionType.Role,
          required: false,
        },
        {
          name: "clan-badge",
          description: "Emoji badge for this tracked clan",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "short-name",
          description: "Short name/abbreviation for this tracked clan",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    },
    {
      name: "remove",
      description: "Remove a clan from tracked clans",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Clan tag to remove",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "type",
          description: "Registry type to remove from (omit for auto/safe lookup)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "FWA", value: "FWA" },
            { name: "CWL", value: "CWL" },
            { name: "RAIDS", value: "RAIDS" },
          ],
        },
      ],
    },
    {
      name: "list",
      description: "List tracked clans",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "type",
          description: "Registry type to list",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "FWA", value: "FWA" },
            { name: "CWL", value: "CWL" },
            { name: "RAIDS", value: "RAIDS" },
          ],
        },
        {
          name: "display",
          description: "Typed list display mode",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "Minimal", value: "minimal" },
            { name: "Detailed", value: "detailed" },
          ],
        },
      ],
    },
    {
      name: "cwl-tags",
      description: "Add one or more CWL tracked clan tags for the current season",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "cwl-tags",
          description: "Array-style or comma-separated clan tags (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "raid-tags",
      description: "Add or update one or more RAIDS tracked clan tags",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "raid-tags",
          description: "Array-style or comma-separated raid tags (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "upgrades",
          description: "Optional manual upgrade count for one raid tag",
          type: ApplicationCommandOptionType.Integer,
          required: false,
        },
      ],
    },
  ],
  run: async (
    client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    try {
      console.info(
        `[tracked-clan] stage=command_entered command=tracked-clan guild=${interaction.guildId ?? "none"} user=${interaction.user.id}`,
      );
      await interaction.deferReply({ ephemeral: true });
      console.info(
        `[tracked-clan] stage=interaction_deferred command=tracked-clan guild=${interaction.guildId ?? "none"} user=${interaction.user.id}`,
      );
      const subcommand = interaction.options.getSubcommand(true);

      if (subcommand === "list") {
        const listType = interaction.options.getString("type", false) as
          | TrackedClanRegistryType
          | null;
        const requestedDisplay = interaction.options.getString("display", false) as
          | "minimal"
          | "detailed"
          | null;
        const displayMode = listType === null ? null : requestedDisplay ?? "minimal";
        if (listType === null) {
          const season = resolveCurrentCwlSeasonKey();
          const [fwaTracked, cwlTracked, raidTracked] = await Promise.all([
            listFwaTrackedClansForDisplay(),
            listCwlTrackedClansForSeason({ season }),
            listRaidTrackedClansForDisplay(),
          ]);

          if (fwaTracked.length === 0 && cwlTracked.length === 0 && raidTracked.length === 0) {
            await safeReply(interaction, {
              ephemeral: true,
              content: "No tracked clans in the database.",
            });
            return;
          }

          const refreshPrefix = `tracked-clan-list:summary:${interaction.id}`;
          const refreshTags = [
            ...fwaTracked.map((clan) => clan.tag),
            ...cwlTracked.map((clan) => clan.tag),
            ...raidTracked.map((clan) => clan.clanTag),
          ];
          let memberCountByTag = await listFwaClanMemberCountsForTags(refreshTags);
          const totalTracked = fwaTracked.length + cwlTracked.length + raidTracked.length;
          const renderOverview = (input: { memberCountByTag: Map<string, number>; refreshing: boolean }) => {
            const sections: Array<{ title: string; lines: string[] }> = [];
            if (fwaTracked.length > 0) {
              sections.push({
                title: "FWA",
                lines: fwaTracked.map((clan) =>
                  buildTrackedClanSummaryLine({
                    ...clan,
                    memberCount: input.memberCountByTag.get(normalizeClanTag(clan.tag) || clan.tag) ?? null,
                  }),
                ),
              });
            }
            if (cwlTracked.length > 0) {
              sections.push({
                title: "CWL",
                lines: cwlTracked.map((clan) =>
                  buildTrackedClanSummaryLine({
                    ...clan,
                    memberCount: input.memberCountByTag.get(normalizeClanTag(clan.tag) || clan.tag) ?? null,
                  }),
                ),
              });
            }
            if (raidTracked.length > 0) {
              sections.push({
                title: "RAIDS",
                lines: raidTracked.map((clan) =>
                  buildRaidTrackedClanSummaryLine({
                    ...clan,
                    memberCount: input.memberCountByTag.get(normalizeClanTag(clan.clanTag) || clan.clanTag) ?? null,
                  }),
                ),
              });
            }

            return {
              embeds: [buildCombinedTrackedClanListEmbed(totalTracked, buildCombinedTrackedClanListDescription(sections))],
              components: buildTrackedClanSummaryRefreshComponents(refreshPrefix, input.refreshing),
            };
          };

          await interaction.editReply(renderOverview({ memberCountByTag, refreshing: false }));

          const message = await interaction.fetchReply();
          const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 10 * 60 * 1000,
            filter: (button) =>
              button.user.id === interaction.user.id &&
              button.customId === `${refreshPrefix}:refresh`,
          });

          collector.on("collect", async (button: ButtonInteraction) => {
            try {
              if (button.user.id !== interaction.user.id || button.customId !== `${refreshPrefix}:refresh`) {
                return;
              }
              const refreshResult = await refreshTrackedClanSummaryView({
                button,
                interaction,
                cocService,
                viewName: "overview",
                displayedClanTags: refreshTags,
                currentMemberCounts: memberCountByTag,
                render: ({ memberCountByTag: counts, refreshing }) =>
                  renderOverview({ memberCountByTag: counts, refreshing }),
              });
              memberCountByTag = refreshResult.refreshedMemberCounts;
            } catch (err) {
              console.error(`tracked-clan overview member-count refresh failed: ${formatError(err)}`);
              if (!button.replied && !button.deferred) {
                await button.reply({
                  ephemeral: true,
                  content: "Failed to refresh tracked clan member counts.",
                });
              } else {
                await button.followUp({
                  ephemeral: true,
                  content: "Failed to refresh tracked clan member counts.",
                });
              }
            }
          });

          collector.on("end", async () => {
            try {
              await interaction.editReply({
                embeds: renderOverview({ memberCountByTag, refreshing: false }).embeds,
                components: [],
              });
            } catch {
              // no-op
            }
          });
          return;
        }

        if (listType === "CWL") {
          const season = resolveCurrentCwlSeasonKey();
          const tracked = await listCwlTrackedClansForSeason({ season });
          if (tracked.length === 0) {
            await safeReply(interaction, {
              ephemeral: true,
              content: `No CWL tracked clans for season ${season}.`,
            });
            return;
          }

          const cwlEmojiTokens = await resolveCwlTrackedClanEmojiTokens(client);

          if (displayMode === "minimal") {
            const refreshPrefix = `tracked-clan-list:cwl-summary:${interaction.id}`;
            let detailedRows = await listCwlTrackedClansForDetailedDisplay({
              season,
              guildId: interaction.guildId ?? null,
            });
            const refreshTags = detailedRows.map((clan) => clan.tag);
            let memberCountByTag = await listFwaClanMemberCountsForTags(refreshTags);
            const renderCwlMinimal = (input: { memberCountByTag: Map<string, number>; refreshing: boolean }) => {
              const lines = detailedRows.map((clan) =>
                buildCwlTrackedClanMinimalLine({
                  ...clan,
                  currentClanMemberCount:
                    input.memberCountByTag.get(normalizeClanTag(clan.tag) || clan.tag) ??
                    clan.currentClanMemberCount ??
                    null,
                }, cwlEmojiTokens),
              );
              return {
                embeds: [
                  buildTrackedClanSectionEmbed(
                    "CWL",
                    detailedRows.length,
                    buildCombinedTrackedClanListDescription([{ title: "CWL", lines }]),
                  ),
                ],
                components: buildTrackedClanSummaryRefreshComponents(refreshPrefix, input.refreshing),
              };
            };
            await interaction.editReply(renderCwlMinimal({ memberCountByTag, refreshing: false }));

            const message = await interaction.fetchReply();
            const collector = message.createMessageComponentCollector({
              componentType: ComponentType.Button,
              time: 10 * 60 * 1000,
              filter: (button) =>
                button.user.id === interaction.user.id &&
                button.customId === `${refreshPrefix}:refresh`,
            });

            collector.on("collect", async (button: ButtonInteraction) => {
              try {
                if (button.user.id !== interaction.user.id || button.customId !== `${refreshPrefix}:refresh`) {
                  return;
                }
                const refreshResult = await refreshTrackedClanSummaryView({
                  button,
                  interaction,
                  cocService,
                  viewName: "cwl-minimal",
                  displayedClanTags: refreshTags,
                  currentMemberCounts: memberCountByTag,
                  render: ({ memberCountByTag: counts, refreshing }) =>
                    renderCwlMinimal({ memberCountByTag: counts, refreshing }),
                });
                memberCountByTag = refreshResult.refreshedMemberCounts;
                detailedRows = await listCwlTrackedClansForDetailedDisplay({
                  season,
                  guildId: interaction.guildId ?? null,
                });
              } catch (err) {
                console.error(`tracked-clan CWL member-count refresh failed: ${formatError(err)}`);
                if (!button.replied && !button.deferred) {
                  await button.reply({
                    ephemeral: true,
                    content: "Failed to refresh tracked clan member counts.",
                  });
                } else {
                  await button.followUp({
                    ephemeral: true,
                    content: "Failed to refresh tracked clan member counts.",
                  });
                }
              }
            });

            collector.on("end", async () => {
              try {
                await interaction.editReply({
                  embeds: renderCwlMinimal({ memberCountByTag, refreshing: false }).embeds,
                  components: [],
                });
              } catch {
                // no-op
              }
            });
            return;
          }

          let detailedRows = await listCwlTrackedClansForDetailedDisplay({
            season,
            guildId: interaction.guildId ?? null,
          });
          const paginatorPrefix = `tracked-clan-list:cwl:${interaction.id}`;
          let page = 0;
          let refreshing = false;
          let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
          let autoRefreshStopped = false;
          type DetailedRefreshSummary = {
            displayedCount: number;
            failedCount: number;
            matchedCount: number;
            searchingCount: number;
            idleCount: number;
          };
          const summarizeDetailedRows = (
            rows: CwlTrackedClanDetailedDisplayRow[],
            failedCount = 0,
          ): DetailedRefreshSummary => {
            let matchedCount = 0;
            let searchingCount = 0;
            let idleCount = 0;
            for (const row of rows) {
              if (row.spinStatus === "matched") {
                matchedCount += 1;
              } else if (row.spinStatus === "searching") {
                searchingCount += 1;
              } else {
                idleCount += 1;
              }
            }
            return {
              displayedCount: rows.length,
              failedCount,
              matchedCount,
              searchingCount,
              idleCount,
            };
          };
          let detailedRefreshSummary = summarizeDetailedRows(detailedRows);
          const formatDetailedRefreshSummary = (summary: DetailedRefreshSummary = detailedRefreshSummary): string =>
            `displayed_count=${summary.displayedCount} matched_count=${summary.matchedCount} searching_count=${summary.searchingCount} idle_count=${summary.idleCount} failed_count=${summary.failedCount}`;
          const logDetailedRefresh = (
            status: "started" | "tick_success" | "tick_failed" | "stopped",
            reason?: string,
            error?: unknown,
          ) => {
            const reasonSuffix = reason ? ` reason=${reason}` : "";
            const errorSuffix = error ? ` error=${formatError(error)}` : "";
            const logLine =
              `[tracked-clan] stage=cwl_detailed_refresh_auto status=${status} season=${season} ${formatDetailedRefreshSummary()}${reasonSuffix}${errorSuffix}`;
            if (status === "tick_failed") {
              console.error(logLine);
              return;
            }
            console.info(logLine);
          };
          const buildDetailedLayout = (refreshing: boolean) => {
            const blocks = detailedRows.map((clan) => buildCwlTrackedClanBlock(clan, cwlEmojiTokens));
            const pageContents = paginateTrackedClanBlocks(blocks);
            const aggregateChars =
              pageContents.reduce((sum, value) => sum + value.length, 0) +
              `Tracked Clans (CWL ${season}) (${detailedRows.length})`.length;
            const canRenderSeamlessly = pageContents.length <= 10 && aggregateChars <= 5800;
            if (canRenderSeamlessly) {
              page = 0;
              return {
                embeds: buildCwlTrackedClanSeamlessEmbeds(detailedRows.length, season, pageContents),
                components: buildCwlTrackedClanListComponents(
                  paginatorPrefix,
                  page,
                  pageContents.length,
                  refreshing,
                  false,
                ),
                totalPages: 1,
                paginated: false,
              };
            }

            const totalPages = Math.max(1, pageContents.length);
            if (page >= totalPages) {
              page = totalPages - 1;
            }
            const pageContent = pageContents[page] ?? "";
            return {
              embeds: [
                buildCwlTrackedClanListEmbed(detailedRows.length, season, pageContent, page, totalPages),
              ],
              components: buildCwlTrackedClanListComponents(
                paginatorPrefix,
                page,
                totalPages,
                refreshing,
                true,
              ),
              totalPages,
              paginated: true,
            };
          };

          const stopAutoRefreshTimer = (
            reason: "all_matched" | "collector_ended" | "message_unavailable" | "no_searching_rows",
          ) => {
            if (autoRefreshTimer !== null) {
              clearInterval(autoRefreshTimer);
              autoRefreshTimer = null;
            }
            if (!autoRefreshStopped) {
              autoRefreshStopped = true;
              logDetailedRefresh("stopped", reason);
            }
          };

          const hasSearchingRows = () => detailedRows.some((row) => row.spinStatus === "searching");

          const maybeStartAutoRefreshTimer = () => {
            if (autoRefreshTimer !== null || autoRefreshStopped || refreshing || !hasSearchingRows()) {
              return;
            }
            autoRefreshTimer = setInterval(() => {
              if (refreshing) {
                return;
              }
              void runDetailedRefresh("auto");
            }, 2 * 60 * 1000);
            logDetailedRefresh("started");
          };

          const isPermanentDetailedEditFailure = (err: unknown): boolean => {
            const normalized = formatError(err).toLowerCase();
            return (
              normalized.includes("unknown message") ||
              normalized.includes("unknown interaction") ||
              normalized.includes("unknown webhook") ||
              normalized.includes("missing access") ||
              normalized.includes("message unavailable") ||
              normalized.includes("cannot edit")
            );
          };

          const runDetailedRefresh = async (source: "manual" | "auto", button?: ButtonInteraction) => {
            if (refreshing) {
              if (source === "manual" && button && !button.replied && !button.deferred) {
                try {
                  await button.deferUpdate();
                } catch {
                  // no-op
                }
              }
              return;
            }

            refreshing = true;
            try {
              if (source === "manual" && button) {
                try {
                  await button.update(buildDetailedLayout(true));
                } catch (err) {
                  if (isPermanentDetailedEditFailure(err)) {
                    stopAutoRefreshTimer("message_unavailable");
                    return;
                  }
                  if (!button.replied && !button.deferred) {
                    try {
                      await button.deferUpdate();
                    } catch {
                      // no-op
                    }
                  }
                }
              } else if (source === "auto") {
                try {
                  await interaction.editReply(buildDetailedLayout(true));
                } catch (err) {
                  if (isPermanentDetailedEditFailure(err)) {
                    logDetailedRefresh("tick_failed", "message_unavailable", err);
                    stopAutoRefreshTimer("message_unavailable");
                    return;
                  }
                  throw err;
                }
              }

              const refreshResult = await refreshCwlTrackedClanDetailedDisplayWithQueueContext({
                season,
                guildId: interaction.guildId ?? null,
                cocService,
              });
              detailedRows = refreshResult.rows;
              detailedRefreshSummary = summarizeDetailedRows(detailedRows, refreshResult.failedClanCount);
              try {
                await interaction.editReply(buildDetailedLayout(false));
              } catch (err) {
                if (isPermanentDetailedEditFailure(err)) {
                  if (source === "auto") {
                    logDetailedRefresh("tick_failed", "message_unavailable", err);
                  }
                  stopAutoRefreshTimer("message_unavailable");
                  return;
                }
                throw err;
              }
              if (source === "auto") {
                logDetailedRefresh("tick_success");
              }
              if (!hasSearchingRows()) {
                stopAutoRefreshTimer("no_searching_rows");
              }
              if (source === "manual" && button && refreshResult.failedClanCount > 0) {
                const failedMessage =
                  refreshResult.failedClanCount >= detailedRows.length
                    ? "Failed to refresh detailed CWL clan data."
                    : `Failed to refresh some CWL clan data: ${refreshResult.failedClanTags.join(", ")}`;
                await button.followUp({
                  ephemeral: true,
                  content: failedMessage,
                });
              }
            } catch (err) {
              console.error(`tracked-clan CWL detailed refresh failed: ${formatError(err)}`);
              if (source === "auto") {
                logDetailedRefresh("tick_failed", undefined, err);
              }
              try {
                await interaction.editReply(buildDetailedLayout(false));
              } catch (editErr) {
                if (isPermanentDetailedEditFailure(editErr)) {
                  if (source === "auto") {
                    logDetailedRefresh("tick_failed", "message_unavailable", editErr);
                  }
                  stopAutoRefreshTimer("message_unavailable");
                  return;
                }
              }
              if (source === "manual" && button) {
                if (!button.replied && !button.deferred) {
                  await button.reply({
                    ephemeral: true,
                    content: "Failed to update clan CWL list page.",
                  });
                }
              }
            } finally {
              refreshing = false;
              if (!autoRefreshStopped && hasSearchingRows()) {
                maybeStartAutoRefreshTimer();
              }
            }
          };

          await interaction.editReply(buildDetailedLayout(false));
          maybeStartAutoRefreshTimer();

          const message = await interaction.fetchReply();
          const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 10 * 60 * 1000,
          });

          collector.on("collect", async (button: ButtonInteraction) => {
            try {
              if (button.user.id !== interaction.user.id) {
                await button.reply({
                  content: "Only the command user can control this paginator.",
                  ephemeral: true,
                });
                return;
              }
              if (
                button.customId !== `${paginatorPrefix}:prev` &&
                button.customId !== `${paginatorPrefix}:next` &&
                button.customId !== `${paginatorPrefix}:refresh`
              ) {
                return;
              }

              if (button.customId === `${paginatorPrefix}:refresh`) {
                await runDetailedRefresh("manual", button);
                return;
              }

              const currentRender = buildDetailedLayout(false);
              if (currentRender.paginated) {
                if (button.customId.endsWith(":prev")) page = Math.max(0, page - 1);
                if (button.customId.endsWith(":next")) page = Math.min(currentRender.totalPages - 1, page + 1);

                const nextRender = buildDetailedLayout(false);
                await button.update({
                  embeds: nextRender.embeds,
                  components: nextRender.components,
                });
              }
            } catch (err) {
              console.error(`tracked-clan CWL detailed refresh failed: ${formatError(err)}`);
              if (!button.replied && !button.deferred) {
                await button.reply({
                  ephemeral: true,
                  content: "Failed to update clan CWL list page.",
                });
              }
            }
          });

          collector.on("end", async () => {
            if (autoRefreshTimer !== null) {
              clearInterval(autoRefreshTimer);
              autoRefreshTimer = null;
            }
            if (!autoRefreshStopped) {
              autoRefreshStopped = true;
              logDetailedRefresh("stopped", "collector_ended");
            }
            try {
              await interaction.editReply({
                ...buildDetailedLayout(false),
                components: [],
              });
            } catch {
              // no-op
            }
          });
          return;
        }

        if (listType === "RAIDS") {
          let tracked = await listRaidTrackedClansForDisplay();
          if (tracked.length === 0) {
            await safeReply(interaction, {
              ephemeral: true,
              content: "No RAIDS tracked clans in the database.",
            });
            return;
          }

          if (displayMode === "minimal") {
            const refreshPrefix = `tracked-clan-list:raids-summary:${interaction.id}`;
            const refreshTags = tracked.map((clan) => normalizeRaidTrackedClanTag(clan.clanTag) || clan.clanTag);
            let memberCountByTag = await listFwaClanMemberCountsForTags(refreshTags);
            const renderRaidsMinimal = (input: { memberCountByTag: Map<string, number>; refreshing: boolean }) => {
              const lines = tracked.map((clan) =>
                buildRaidTrackedClanSummaryLine({
                  ...clan,
                  memberCount: input.memberCountByTag.get(normalizeClanTag(clan.clanTag) || clan.clanTag) ?? null,
                }),
              );
              return {
                embeds: [
                  buildTrackedClanSectionEmbed(
                    "RAIDS",
                    tracked.length,
                    buildCombinedTrackedClanListDescription([{ title: "RAIDS", lines }]),
                  ),
                ],
                components: buildTrackedClanSummaryRefreshComponents(refreshPrefix, input.refreshing),
              };
            };
            await interaction.editReply(renderRaidsMinimal({ memberCountByTag, refreshing: false }));

            const message = await interaction.fetchReply();
            const collector = message.createMessageComponentCollector({
              componentType: ComponentType.Button,
              time: 10 * 60 * 1000,
              filter: (button) =>
                button.user.id === interaction.user.id &&
                button.customId === `${refreshPrefix}:refresh`,
            });

            collector.on("collect", async (button: ButtonInteraction) => {
              try {
                if (button.user.id !== interaction.user.id || button.customId !== `${refreshPrefix}:refresh`) {
                  return;
                }
                const refreshResult = await refreshTrackedClanSummaryView({
                  button,
                  interaction,
                  cocService,
                  viewName: "raids-minimal",
                  displayedClanTags: refreshTags,
                  currentMemberCounts: memberCountByTag,
                  render: ({ memberCountByTag: counts, refreshing }) =>
                    renderRaidsMinimal({ memberCountByTag: counts, refreshing }),
                });
                memberCountByTag = refreshResult.refreshedMemberCounts;
              } catch (err) {
                console.error(`tracked-clan RAIDS member-count refresh failed: ${formatError(err)}`);
                if (!button.replied && !button.deferred) {
                  await button.reply({
                    ephemeral: true,
                    content: "Failed to refresh tracked clan member counts.",
                  });
                } else {
                  await button.followUp({
                    ephemeral: true,
                    content: "Failed to refresh tracked clan member counts.",
                  });
                }
              }
            });

            collector.on("end", async () => {
              try {
                await interaction.editReply({
                  embeds: renderRaidsMinimal({ memberCountByTag, refreshing: false }).embeds,
                  components: [],
                });
              } catch {
                // no-op
              }
            });
            return;
          }

          let blocks = buildRaidTrackedClanListLines(tracked);
          let pages = paginateTextLines(blocks);
          let page = 0;
          let refreshing = false;
          const paginatorPrefix = `tracked-clan-list:raids:${interaction.id}`;

          await interaction.editReply({
            embeds: [buildRaidTrackedClanListEmbed(tracked.length, pages[page], page, pages.length)],
            components: buildRaidTrackedClanListComponents(
              paginatorPrefix,
              page,
              pages.length,
              refreshing,
            ),
          });

          const message = await interaction.fetchReply();
          const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 10 * 60 * 1000,
            filter: (button) =>
              button.user.id === interaction.user.id &&
              (button.customId === `${paginatorPrefix}:refresh` ||
                button.customId === `${paginatorPrefix}:prev` ||
                button.customId === `${paginatorPrefix}:next`),
          });

          collector.on("collect", async (button: ButtonInteraction) => {
            try {
              if (button.user.id !== interaction.user.id) {
                await button.reply({
                  content: "Only the command user can control this paginator.",
                  ephemeral: true,
                });
                return;
              }

              if (button.customId === `${paginatorPrefix}:refresh`) {
                if (refreshing) {
                  return;
                }

                refreshing = true;
                const currentEmbed = buildRaidTrackedClanListEmbed(
                  tracked.length,
                  pages[page],
                  page,
                  pages.length,
                );
                await button.update({
                  embeds: [currentEmbed],
                  components: buildRaidTrackedClanListComponents(
                    paginatorPrefix,
                    page,
                    pages.length,
                    true,
                  ),
                });

                try {
                  const refreshResult = await refreshRaidTrackedClanListWithQueueContext({
                    cocService,
                  });
                  tracked = await listRaidTrackedClansForDisplay();
                  blocks = buildRaidTrackedClanListLines(tracked);
                  pages = paginateTextLines(blocks);
                  page = Math.min(page, pages.length - 1);
                  if (tracked.length === 0 || pages.length === 0) {
                    await interaction.editReply({
                      content: "No RAIDS tracked clans in the database.",
                      embeds: [],
                      components: [],
                    });
                    return;
                  }

                  if (refreshResult.joinTypeRefreshFailures.length > 0) {
                    console.error(
                      `[tracked-clan] stage=raids_refresh_failed tags=${formatTagListForSummary(refreshResult.joinTypeRefreshFailures)}`,
                    );
                  }

                  await interaction.editReply({
                    embeds: [buildRaidTrackedClanListEmbed(tracked.length, pages[page], page, pages.length)],
                    components: buildRaidTrackedClanListComponents(
                      paginatorPrefix,
                      page,
                      pages.length,
                      false,
                    ),
                  });
                } catch (err) {
                  console.error(`tracked-clan RAIDS list refresh failed: ${formatError(err)}`);
                  await interaction.editReply({
                    embeds: [currentEmbed],
                    components: buildRaidTrackedClanListComponents(
                      paginatorPrefix,
                      page,
                      pages.length,
                      false,
                    ),
                  });
                  await button.followUp({
                    ephemeral: true,
                    content: "Failed to refresh tracked-clan RAIDS data.",
                  });
                } finally {
                  refreshing = false;
                }
                return;
              }

              if (button.customId !== `${paginatorPrefix}:prev` && button.customId !== `${paginatorPrefix}:next`) {
                return;
              }

              if (button.customId.endsWith(":prev")) page = Math.max(0, page - 1);
              if (button.customId.endsWith(":next")) page = Math.min(pages.length - 1, page + 1);

              await button.update({
                embeds: [buildRaidTrackedClanListEmbed(tracked.length, pages[page], page, pages.length)],
                components: buildRaidTrackedClanListComponents(
                  paginatorPrefix,
                  page,
                  pages.length,
                  false,
                ),
              });
            } catch (err) {
              console.error(`tracked-clan RAIDS list paginator failed: ${formatError(err)}`);
              if (!button.replied && !button.deferred) {
                await button.reply({
                  ephemeral: true,
                  content: "Failed to update clan RAIDS list page.",
                });
              }
            }
          });

          collector.on("end", async () => {
            try {
              await interaction.editReply({
                embeds: [buildRaidTrackedClanListEmbed(tracked.length, pages[page], page, pages.length)],
                components: [],
              });
            } catch {
              // no-op
            }
          });
          return;
        }

        if (listType === "FWA" && displayMode === "minimal") {
          const fwaMinimalState = await loadFwaTrackedClanMinimalListState();
          if (fwaMinimalState.trackedClans.length === 0) {
            await safeReply(interaction, {
              ephemeral: true,
              content:
              "No tracked clans in the database. You can still set TRACKED_CLANS in .env as fallback.",
            });
            return;
          }
          const refreshPrefix = `tracked-clan-list:fwa-summary:${interaction.id}`;
          let memberCountByTag = fwaMinimalState.memberCountByTag;
          const renderFwaMinimal = (input: { memberCountByTag: Map<string, number>; refreshing: boolean }) =>
            buildFwaTrackedClanMinimalListRender({
              refreshPrefix,
              trackedClans: fwaMinimalState.trackedClans,
              memberCountByTag: input.memberCountByTag,
              refreshing: input.refreshing,
            });
          await interaction.editReply(renderFwaMinimal({ memberCountByTag, refreshing: false }));

          const message = await interaction.fetchReply();
          const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 10 * 60 * 1000,
            filter: (button) =>
              button.user.id === interaction.user.id &&
              button.customId === `${refreshPrefix}:refresh`,
          });

          collector.on("collect", async (button: ButtonInteraction) => {
            try {
              if (button.user.id !== interaction.user.id || button.customId !== `${refreshPrefix}:refresh`) {
                return;
              }
              const refreshResult = await refreshTrackedClanSummaryView({
                button,
                interaction,
                cocService,
                viewName: "fwa-minimal",
                displayedClanTags: fwaMinimalState.refreshTags,
                currentMemberCounts: memberCountByTag,
                render: ({ memberCountByTag: counts, refreshing }) =>
                  renderFwaMinimal({ memberCountByTag: counts, refreshing }),
              });
              memberCountByTag = refreshResult.refreshedMemberCounts;
            } catch (err) {
              console.error(`tracked-clan FWA member-count refresh failed: ${formatError(err)}`);
              if (!button.replied && !button.deferred) {
                await button.reply({
                  ephemeral: true,
                  content: "Failed to refresh tracked clan member counts.",
                });
              } else {
                await button.followUp({
                  ephemeral: true,
                  content: "Failed to refresh tracked clan member counts.",
                });
              }
            }
          });

          collector.on("end", async () => {
            try {
              await interaction.editReply({
                embeds: renderFwaMinimal({ memberCountByTag, refreshing: false }).embeds,
                components: [],
              });
            } catch {
              // no-op
            }
          });
          return;
        }

        const tracked = await listFwaTrackedClansForDisplay();

        if (tracked.length === 0) {
          await safeReply(interaction, {
            ephemeral: true,
            content:
              "No tracked clans in the database. You can still set TRACKED_CLANS in .env as fallback.",
          });
          return;
        }

        const blocks = tracked.map((clan) => buildTrackedClanBlock(clan));
        const pages = paginateTrackedClanBlocks(blocks);
        let page = 0;
        const paginatorPrefix = `tracked-clan-list:${interaction.id}`;

        await interaction.editReply({
          embeds: [buildTrackedClanListEmbed(tracked.length, pages[page], page, pages.length)],
          components: pages.length > 1 ? [buildTrackedClanListRow(paginatorPrefix, page, pages.length)] : [],
        });

        if (pages.length <= 1) {
          return;
        }

        const message = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: 10 * 60 * 1000,
        });

        collector.on("collect", async (button: ButtonInteraction) => {
          try {
            if (button.user.id !== interaction.user.id) {
              await button.reply({
                content: "Only the command user can control this paginator.",
                ephemeral: true,
              });
              return;
            }
            if (
              button.customId !== `${paginatorPrefix}:prev` &&
              button.customId !== `${paginatorPrefix}:next`
            ) {
              return;
            }

            if (button.customId.endsWith(":prev")) page = Math.max(0, page - 1);
            if (button.customId.endsWith(":next")) page = Math.min(pages.length - 1, page + 1);

            await button.update({
              embeds: [buildTrackedClanListEmbed(tracked.length, pages[page], page, pages.length)],
              components: [buildTrackedClanListRow(paginatorPrefix, page, pages.length)],
            });
          } catch (err) {
            console.error(`tracked-clan list paginator failed: ${formatError(err)}`);
            if (!button.replied && !button.deferred) {
              await button.reply({ ephemeral: true, content: "Failed to update clan list page." });
            }
          }
        });

        collector.on("end", async () => {
          try {
            await interaction.editReply({
              embeds: [buildTrackedClanListEmbed(tracked.length, pages[page], page, pages.length)],
              components: [],
            });
          } catch {
            // no-op
          }
        });
        return;
      }

      if (subcommand === "cwl-tags") {
        const rawCwlTags = interaction.options.getString("cwl-tags", true);
        const result = await addCwlClanTagsForSeason({
          rawTags: rawCwlTags,
        });
        const hydrationTags = [...new Set([...result.added, ...result.alreadyExisting])];
        const hydrationPromise =
          cocService && hydrationTags.length > 0
            ? ensureAndHydrateCwlTrackedClanMetadataForSeason({
                season: result.season,
                clanTags: hydrationTags,
                cocService,
                ensureRows: false,
              })
            : Promise.resolve({
                season: result.season,
                requestedCount: 0,
                ensuredCount: 0,
                hydratedCount: 0,
                skippedCount: 0,
              });

        await safeReply(interaction, {
          ephemeral: true,
          content: [
            `Updated CWL tracked clans for season ${result.season}.`,
            `added: ${formatTagListForSummary(result.added)}`,
            `already existed: ${formatTagListForSummary(result.alreadyExisting)}`,
            `invalid: ${formatTagListForSummary(result.invalid)}`,
            `duplicates in request: ${formatTagListForSummary(result.duplicateInRequest)}`,
          ].join("\n"),
        });
        console.info(
          `[tracked-clan] stage=cwl_tags_final_reply_sent season=${result.season} added_count=${result.added.length} existing_count=${result.alreadyExisting.length}`,
        );
        await hydrationPromise.catch((err) => {
          console.error(
            `[tracked-clan] stage=cwl_tags_metadata_hydration_unhandled_error season=${result.season} error=${formatError(err)}`,
          );
        });
        return;
      }

      if (subcommand === "raid-tags") {
        const rawRaidTags = interaction.options.getString("raid-tags", true);
        if (!String(rawRaidTags ?? "").trim()) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Please provide at least one raid tag.",
          });
          return;
        }

        const parsedRaidTags = parseRaidTrackedClanTagsInput(rawRaidTags);
        if (parsedRaidTags.validTags.length === 0) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Raid tags must be valid Clash tags.",
          });
          return;
        }

        const upgrades = interaction.options.getInteger("upgrades", false);
        if (upgrades !== null && parsedRaidTags.validTags.length !== 1) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "upgrades can only be set when exactly one raid tag is provided.",
          });
          return;
        }
        if (upgrades !== null && (upgrades < 2000 || upgrades > 3331)) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "upgrades must be a whole number between 2000 and 3331.",
          });
          return;
        }

        const result = await upsertRaidTrackedClansForTags({
          rawTags: rawRaidTags,
          upgrades,
          cocService,
        });

        await safeReply(interaction, {
          ephemeral: true,
          content: [
            "Updated RAIDS tracked clans.",
            `added: ${formatTagListForSummary(result.added)}`,
            `updated upgrades: ${formatTagListForSummary(result.updated)}`,
            `already-existing: ${formatTagListForSummary(result.alreadyExisting)}`,
            `invalid: ${formatTagListForSummary(result.invalid)}`,
            `duplicates-ignored: ${formatTagListForSummary(result.duplicateInRequest)}`,
            ...(result.joinTypeRefreshFailures.length > 0
              ? [
                  `joinType refresh failures: ${formatTagListForSummary(result.joinTypeRefreshFailures)}`,
                ]
              : []),
          ].join("\n"),
        });
        return;
      }

      if (subcommand === "configure") {
        const tagInput = interaction.options.getString("tag", true);
        const tag = normalizeClanTag(tagInput);
        if (!tag) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Invalid clan tag format. Use a valid clan tag with or without `#`.",
          });
          return;
        }

        const loseStyle = interaction.options.getString("lose-style", false) as
          | "TRIPLE_TOP_30"
          | "TRADITIONAL"
          | null;
        const mailChannel = interaction.options.getChannel("mail-channel", false);
        const logChannel = interaction.options.getChannel("log-channel", false);
        const leaderChannel = interaction.options.getChannel("leader-channel", false);
        const clanRole = interaction.options.getRole("clan-role", false);
        const leadRole = interaction.options.getRole("lead-role", false);
        const clanBadgeInput = interaction.options.getString("clan-badge", false);
        const shortNameInput = interaction.options.getString("short-name", false);
        let clanBadge: string | null = null;
        const shortName = shortNameInput ? normalizeClanShortNameInput(shortNameInput) : null;
        if (mailChannel && (!("isTextBased" in mailChannel) || !(mailChannel as any).isTextBased())) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Mail channel must be a text-based channel.",
          });
          return;
        }
        if (logChannel && (!("isTextBased" in logChannel) || !(logChannel as any).isTextBased())) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Log channel must be a text-based channel.",
          });
          return;
        }
        if (leaderChannel && (!("isTextBased" in leaderChannel) || !(leaderChannel as any).isTextBased())) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Leader channel must be a text-based channel.",
          });
          return;
        }
        if (clanRole && !("id" in clanRole)) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Invalid clan role selected.",
          });
          return;
        }
        if (leadRole && !("id" in leadRole)) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Invalid lead role selected.",
          });
          return;
        }
        if (clanBadgeInput) {
          try {
            clanBadge = await normalizeClanBadgeInput(interaction, clanBadgeInput);
          } catch (badgeErr) {
            const badgeCode = formatError(badgeErr);
            const badgeHint =
              badgeCode === "CLAN_BADGE_GUILD_REQUIRED"
                ? "Custom clan-badge shortcodes can only be resolved in a server."
                : badgeCode === "CLAN_BADGE_SHORTCODE_NOT_FOUND"
                  ? "Could not find that emoji in this server. Use an existing server emoji, unicode emoji, or full custom emoji format like `<:Logo_Gabbar:123456789012345678>`."
                  : "Invalid clan-badge value. Use unicode emoji, `:emoji_name:` from this server, or full custom emoji format.";
            await safeReply(interaction, {
              ephemeral: true,
              content: badgeHint,
            });
            return;
          }
        }
        const existing = await prisma.trackedClan.findUnique({
          where: { tag },
        });
        const clan = await cocService.getClan(tag);
        const activityService = new ActivityService(cocService);
        const createLoseStyle = loseStyle ?? "TRIPLE_TOP_30";
        const saved = await prisma.trackedClan.upsert({
          where: { tag },
          create: {
            tag,
            name: clan.name ?? null,
            loseStyle: createLoseStyle,
            mailChannelId: mailChannel?.id ?? null,
            logChannelId: logChannel?.id ?? null,
            leaderChannelId: leaderChannel?.id ?? null,
            clanRoleId: clanRole?.id ?? null,
            leadRoleId: leadRole?.id ?? null,
            clanBadge,
            shortName,
          },
          update: {
            name: clan.name ?? null,
            ...(loseStyle ? { loseStyle } : {}),
            ...(mailChannel ? { mailChannelId: mailChannel.id } : {}),
            ...(logChannel ? { logChannelId: logChannel.id } : {}),
            ...(leaderChannel ? { leaderChannelId: leaderChannel.id } : {}),
            ...(clanRole ? { clanRoleId: clanRole.id } : {}),
            ...(leadRole ? { leadRoleId: leadRole.id } : {}),
            ...(clanBadge ? { clanBadge } : {}),
            ...(shortName ? { shortName } : {}),
          },
        });

        if (!existing && interaction.guildId) {
          try {
            await activityService.observeClan(interaction.guildId, tag);
          } catch (observeErr) {
            console.error(
              `tracked-clan configure observe failed for ${tag}: ${formatError(observeErr)}`
            );
          }
        }

        if (interaction.guildId) {
          const activeWar = await cocService.getCurrentWar(tag).catch(() => null);
          const state = String(activeWar?.state ?? "notInWar");
          const opponentTag = normalizeClanTag(String(activeWar?.opponent?.tag ?? ""));
          const opponentName = String(activeWar?.opponent?.name ?? "").trim() || null;
          const warStartTimeRaw = String(activeWar?.startTime ?? "");
          const warStartMatch = warStartTimeRaw.match(
            /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.\d{3}Z$/
          );
          const warStartTime = warStartMatch
            ? new Date(
                Date.UTC(
                  Number(warStartMatch[1]),
                  Number(warStartMatch[2]) - 1,
                  Number(warStartMatch[3]),
                  Number(warStartMatch[4]),
                  Number(warStartMatch[5]),
                  Number(warStartMatch[6])
                )
              )
            : null;
          const prepStartTimeRaw = String(activeWar?.preparationStartTime ?? "");
          const prepStartMatch = prepStartTimeRaw.match(
            /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.\d{3}Z$/
          );
          const prepStartTime = prepStartMatch
            ? new Date(
                Date.UTC(
                  Number(prepStartMatch[1]),
                  Number(prepStartMatch[2]) - 1,
                  Number(prepStartMatch[3]),
                  Number(prepStartMatch[4]),
                  Number(prepStartMatch[5]),
                  Number(prepStartMatch[6])
                )
              )
            : null;
          const warEndTimeRaw = String(activeWar?.endTime ?? "");
          const warEndMatch = warEndTimeRaw.match(
            /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.\d{3}Z$/
          );
          const warEndTime = warEndMatch
            ? new Date(
                Date.UTC(
                  Number(warEndMatch[1]),
                  Number(warEndMatch[2]) - 1,
                  Number(warEndMatch[3]),
                  Number(warEndMatch[4]),
                  Number(warEndMatch[5]),
                  Number(warEndMatch[6])
                )
              )
            : null;
          await prisma.currentWar.upsert({
            where: {
              clanTag_guildId: {
                guildId: interaction.guildId,
                clanTag: tag,
              },
            },
            create: {
              guildId: interaction.guildId,
              clanTag: tag,
              channelId: interaction.channelId,
              notify: false,
              state,
              prepStartTime,
              startTime: warStartTime,
              endTime: warEndTime,
              opponentTag: opponentTag || null,
              opponentName: opponentName,
              clanName: saved.name ?? null,
            },
            update: {
              clanName: saved.name ?? null,
              state,
              prepStartTime,
              startTime: warStartTime,
              endTime: warEndTime,
              opponentTag: opponentTag || null,
              opponentName: opponentName,
              updatedAt: new Date(),
            },
          });
        }

        const summary = [
          `lose-style: ${saved.loseStyle}`,
          `mailChannel: ${saved.mailChannelId ? `<#${saved.mailChannelId}>` : "not set"}`,
          `logChannel: ${saved.logChannelId ? `<#${saved.logChannelId}>` : "not set"}`,
          `leaderChannel: ${saved.leaderChannelId ? `<#${saved.leaderChannelId}>` : "not set"}`,
          `clanRole: ${saved.clanRoleId ? `<@&${saved.clanRoleId}>` : "not set"}`,
          `leadRole: ${saved.leadRoleId ? `<@&${saved.leadRoleId}>` : "not set"}`,
          `clanBadge: ${saved.clanBadge ?? "not set"}`,
          `shortName: ${saved.shortName ?? "not set"}`,
        ].join(" | ");

        await safeReply(interaction, {
          ephemeral: true,
          content: existing
            ? `Updated tracked clan ${saved.name ?? "Unknown Clan"} (${saved.tag}) | ${summary}`
            : `Now tracking ${saved.name ?? "Unknown Clan"} (${saved.tag}) | ${summary}`,
        });
        return;
      }

      if (subcommand === "remove") {
        const tagInput = interaction.options.getString("tag", true);
        const tag = normalizeClanTag(tagInput);
        if (!tag) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Invalid clan tag format. Use a valid clan tag with or without `#`.",
          });
          return;
        }
        const requestedType =
          (interaction.options.getString("type", false) as TrackedClanRegistryType | null) ?? null;
        const result = await removeTrackedClanTagFromRegistries({
          tag,
          type: requestedType,
        });
        if (result.outcome === "not_found") {
          await safeReply(interaction, {
            ephemeral: true,
            content: `${tag} was not found in ${requestedType ? `${requestedType} tracked clans` : "FWA tracked clans or current-season CWL tracked clans"}.`,
          });
          return;
        }
        if (result.outcome === "ambiguous") {
          await safeReply(interaction, {
            ephemeral: true,
            content:
              `Ambiguous remove for ${tag}: it exists in multiple tracked-clan registries (${result.season}).\n` +
              "Re-run `/clan remove` with `type:FWA`, `type:CWL`, or `type:RAIDS`.",
          });
          return;
        }

        if (result.removedFrom === "FWA" && interaction.guildId) {
          await prisma.currentWar.deleteMany({
            where: {
              guildId: interaction.guildId,
              clanTag: tag,
            },
          });
        }

        await safeReply(interaction, {
          ephemeral: true,
          content:
            result.removedFrom === "FWA"
              ? `Removed tracked clan ${tag} from FWA registry.`
              : result.removedFrom === "CWL"
                ? `Removed tracked clan ${tag} from CWL registry for season ${result.season}.`
                : `Removed tracked clan ${tag} from RAIDS registry.`,
        });
      }
    } catch (err) {
      console.error(`tracked-clan command failed: ${formatError(err)}`);
      await safeReply(interaction, {
        ephemeral: true,
        content: "Failed to update tracked clans. Check the clan tag and try again.",
      });
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "tag") {
      await interaction.respond([]);
      return;
    }

    const subcommand = interaction.options.getSubcommand(false);
    const query = String(focused.value ?? "").trim().toLowerCase();
    if (subcommand === "remove") {
      const season = resolveCurrentCwlSeasonKey();
      const [trackedFwa, trackedCwl, trackedRaid] = await Promise.all([
        prisma.trackedClan.findMany({
          orderBy: { createdAt: "asc" },
          select: { name: true, tag: true },
        }),
        prisma.cwlTrackedClan.findMany({
          where: { season },
          orderBy: { createdAt: "asc" },
          select: { name: true, tag: true },
        }),
        prisma.raidTrackedClan.findMany({
          orderBy: [{ createdAt: "asc" }, { clanTag: "asc" }],
          select: { clanTag: true },
        }),
      ]);

      const choiceByTag = new Map<string, { name: string; value: string }>();
      for (const clan of trackedFwa) {
        const tag = normalizeClanTag(clan.tag);
        if (!tag) continue;
        const label = clan.name?.trim() ? `${clan.name.trim()} (${tag}) [FWA]` : `${tag} [FWA]`;
        choiceByTag.set(tag, { name: label.slice(0, 100), value: tag });
      }
      for (const clan of trackedCwl) {
        const tag = normalizeClanTag(clan.tag);
        if (!tag) continue;
        const existing = choiceByTag.get(tag);
        if (existing) {
          const merged = existing.name.includes(`[CWL ${season}]`)
            ? existing.name
            : `${existing.name} [CWL ${season}]`;
          choiceByTag.set(tag, {
            name: merged.slice(0, 100),
            value: tag,
          });
          continue;
        }
        const label = clan.name?.trim()
          ? `${clan.name.trim()} (${tag}) [CWL ${season}]`
          : `${tag} [CWL ${season}]`;
        choiceByTag.set(tag, { name: label.slice(0, 100), value: tag });
      }
      for (const clan of trackedRaid) {
        const tag = normalizeRaidTrackedClanTag(clan.clanTag);
        if (!tag) continue;
        const existing = choiceByTag.get(`#${tag}`);
        if (existing) {
          const merged = existing.name.includes("[RAIDS]")
            ? existing.name
            : `${existing.name} [RAIDS]`;
          choiceByTag.set(`#${tag}`, {
            name: merged.slice(0, 100),
            value: `#${tag}`,
          });
          continue;
        }
        choiceByTag.set(`#${tag}`, {
          name: `${tag} [RAIDS]`.slice(0, 100),
          value: `#${tag}`,
        });
      }

      const choices = [...choiceByTag.values()]
        .filter(
          (choice) =>
            choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query)
        )
        .slice(0, 25);

      await interaction.respond(choices);
      return;
    }

    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });
    const choices = tracked
      .map((clan) => {
        const tag = normalizeClanTag(clan.tag);
        const label = clan.name?.trim() ? `${clan.name.trim()} (${tag})` : tag;
        return { name: label.slice(0, 100), value: tag };
      })
      .filter(
        (choice) =>
          choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query)
      )
      .slice(0, 25);

    await interaction.respond(choices);
  },
};

