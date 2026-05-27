import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import { CommandPermissionService } from "../services/CommandPermissionService";
import {
  autoRoleRefreshService,
  type AutoRoleRefreshResult,
} from "../services/AutoRoleRefreshService";
import {
  autoRoleService,
  formatAutoRoleRuleTarget,
  formatAutoRoleRuleType,
  type AutoRoleGuildConfigRecord,
  type AutoRoleGuildConfigUpdateInput,
  type AutoRoleRuleCreateInput,
  type AutoRoleRuleRecord,
  type AutoRoleRuleUpdateInput,
} from "../services/AutoRoleService";

const AUTOROLE_PAGE_LIMIT = 3900;
const AUTOROLE_PAGE_TIMEOUT_MS = 10 * 60 * 1000;
const AUTOROLE_PREV_ID = "autorole-page-prev";
const AUTOROLE_NEXT_ID = "autorole-page-next";

const AUTOROLE_RULE_TYPE_CHOICES = [
  { name: "Verified", value: "VERIFIED" },
  { name: "Family", value: "FAMILY" },
  { name: "Clan", value: "CLAN" },
  { name: "Clan Rank", value: "CLAN_ROLE" },
  { name: "League", value: "LEAGUE" },
  { name: "Town Hall", value: "TOWN_HALL" },
  { name: "Label", value: "LABEL" },
] as const;

function hasAdministratorPermission(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function boolLabel(value: boolean): string {
  return value ? "enabled" : "disabled";
}

function maybeRoleLabel(roleId: string | null): string {
  return roleId ? `<@&${roleId}>` : "none";
}

async function resolveRolePresence(
  guild: ChatInputCommandInteraction["guild"] | null | undefined,
  roleId: string | null | undefined,
): Promise<"present" | "missing" | null> {
  const normalizedRoleId = String(roleId ?? "").trim();
  if (!normalizedRoleId) return null;
  if (!guild?.roles) return null;
  const cached = guild.roles.cache?.get(normalizedRoleId) ?? null;
  if (cached) return "present";
  const fetched = await guild.roles.fetch(normalizedRoleId).catch(() => null);
  return fetched ? "present" : "missing";
}

function maybeTextLabel(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : "none";
}

function maybeMinutesLabel(value: number | null): string {
  return value === null ? "none" : `${value} minute(s)`;
}

function formatRuleLine(rule: AutoRoleRuleRecord): string {
  const status = rule.enabled ? "enabled" : "disabled";
  return [
    `- \`${rule.id}\` **${formatAutoRoleRuleType(rule.type)}**`,
    `role: <@&${rule.discordRoleId}>`,
    `target: ${formatAutoRoleRuleTarget(rule)}`,
    `priority: ${rule.priority}`,
    `status: ${status}`,
  ].join(" | ");
}

function formatExclusionUserLine(row: {
  discordUserId: string;
  reason: string | null;
}): string {
  const reason = row.reason ? ` — ${row.reason}` : "";
  return `- <@${row.discordUserId}>${reason}`;
}

function formatExclusionRoleLine(row: {
  discordRoleId: string;
  reason: string | null;
}): string {
  const reason = row.reason ? ` — ${row.reason}` : "";
  return `- <@&${row.discordRoleId}>${reason}`;
}

function paginateText(lines: string[]): string[] {
  const pages: string[] = [];
  let current = "";

  for (const line of lines) {
    const next = current.length > 0 ? `${current}\n${line}` : line;
    if (next.length > AUTOROLE_PAGE_LIMIT && current.length > 0) {
      pages.push(current);
      current = line;
      continue;
    }
    current = next;
  }

  if (current.length > 0) {
    pages.push(current);
  }

  return pages.length > 0 ? pages : [""];
}

function buildPageEmbed(
  title: string,
  description: string,
  page: number,
  totalPages: number,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x57f287)
    .setDescription(description || " ")
    .setFooter({ text: `Page ${page + 1}/${totalPages}` });
  return embed;
}

function buildPagerRow(page: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(AUTOROLE_PREV_ID)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(AUTOROLE_NEXT_ID)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

async function replyPagedLines(
  interaction: ChatInputCommandInteraction,
  title: string,
  lines: string[],
  content?: string,
): Promise<void> {
  const pages = paginateText(lines);
  const totalPages = pages.length;
  let page = 0;

  await interaction.editReply({
    content,
    embeds: [buildPageEmbed(title, pages[page] ?? "", page, totalPages)],
    components: totalPages > 1 ? [buildPagerRow(page, totalPages)] : [],
  });

  if (totalPages <= 1) return;

  const message = await interaction.fetchReply();
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: AUTOROLE_PAGE_TIMEOUT_MS,
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

      if (button.customId === AUTOROLE_PREV_ID && page > 0) {
        page -= 1;
      } else if (button.customId === AUTOROLE_NEXT_ID && page < totalPages - 1) {
        page += 1;
      }

      await button.update({
        content,
        embeds: [buildPageEmbed(title, pages[page] ?? "", page, totalPages)],
        components: [buildPagerRow(page, totalPages)],
      });
    } catch (error) {
      console.error(`autorole paginator failed: ${formatError(error)}`);
      try {
        if (!button.replied && !button.deferred) {
          await button.reply({
            content: "Failed to update paginator.",
            ephemeral: true,
          });
        }
      } catch {
        // no-op
      }
    }
  });

  collector.on("end", async () => {
    try {
      await interaction.editReply({ components: [] });
    } catch {
      // no-op
    }
  });
}

function buildConfigEmbed(
  config: AutoRoleGuildConfigRecord,
  input?: {
    visitorRolePresence?: "present" | "missing" | null;
  },
): EmbedBuilder {
  const lines = [
    `Enabled: ${boolLabel(config.enabled)}`,
    `Kill switch: ${boolLabel(config.killSwitchEnabled)}`,
    `Remove stale managed roles: ${boolLabel(config.removeStaleManagedRoles)}`,
    `Apply nicknames: ${boolLabel(config.applyNicknames)}`,
    `Nickname template: ${maybeTextLabel(config.nicknameTemplate)}`,
    `Trusted links allowed: ${boolLabel(config.trustedLinksAllowed)}`,
    `Verified-only mode: ${boolLabel(config.verifiedOnlyMode)}`,
    `Sync enabled: ${boolLabel(config.syncEnabled)}`,
    `Sync interval: ${maybeMinutesLabel(config.syncIntervalMinutes)}`,
    `Verified role: ${maybeRoleLabel(config.verifiedRoleId)}`,
    `Family role: ${maybeRoleLabel(config.familyRoleId)}`,
    `CWL clan role: ${maybeRoleLabel(config.cwlClanRoleId)}`,
    `Visitor role: ${maybeRoleLabel(config.nonMemberRoleId)}`,
    `Visitor role enabled: ${boolLabel(config.nonMemberEnabled)}`,
    ...(config.nonMemberRoleId && input?.visitorRolePresence === "missing"
      ? ["Visitor role warning: missing/deleted"]
      : []),
    `Clan role removal delay: ${maybeMinutesLabel(config.clanRoleRemovalDelayMinutes)}`,
  ];

  return new EmbedBuilder()
    .setTitle("Autorole Config")
    .setColor(0x57f287)
    .setDescription(lines.join("\n"));
}

function buildRuleLines(rules: AutoRoleRuleRecord[]): string[] {
  if (rules.length === 0) {
    return ["No autorole rules are configured yet."];
  }
  return rules.map(formatRuleLine);
}

function buildExclusionLines(exclusions: {
  users: Array<{ discordUserId: string; reason: string | null }>;
  roles: Array<{ discordRoleId: string; reason: string | null }>;
}): string[] {
  const lines: string[] = [];
  lines.push(`Users (${exclusions.users.length})`);
  if (exclusions.users.length === 0) {
    lines.push("  (none)");
  } else {
    for (const row of exclusions.users) {
      lines.push(`  ${formatExclusionUserLine(row)}`);
    }
  }

  lines.push("");
  lines.push(`Roles (${exclusions.roles.length})`);
  if (exclusions.roles.length === 0) {
    lines.push("  (none)");
  } else {
    for (const row of exclusions.roles) {
      lines.push(`  ${formatExclusionRoleLine(row)}`);
    }
  }

  return lines;
}

function getStringOption(
  interaction: ChatInputCommandInteraction,
  name: string,
): string | null {
  return interaction.options.getString(name, false);
}

function getBooleanOption(
  interaction: ChatInputCommandInteraction,
  name: string,
): boolean | null {
  return interaction.options.getBoolean(name, false);
}

function getIntegerOption(
  interaction: ChatInputCommandInteraction,
  name: string,
): number | null {
  return interaction.options.getInteger(name, false);
}

function getRoleOptionId(
  interaction: ChatInputCommandInteraction,
  name: string,
): string | null {
  const role = interaction.options.getRole(name, false);
  return role && "id" in role ? role.id : null;
}

function buildConfigUpdateInput(
  interaction: ChatInputCommandInteraction,
): AutoRoleGuildConfigUpdateInput {
  const update: AutoRoleGuildConfigUpdateInput = {};

  for (const [optionName, fieldName] of [
    ["enabled", "enabled"],
    ["kill_switch_enabled", "killSwitchEnabled"],
    ["remove_stale_managed_roles", "removeStaleManagedRoles"],
    ["apply_nicknames", "applyNicknames"],
    ["trusted_links_allowed", "trustedLinksAllowed"],
    ["verified_only_mode", "verifiedOnlyMode"],
    ["sync_enabled", "syncEnabled"],
  ] as const) {
    const value = getBooleanOption(interaction, optionName);
    if (value !== null) update[fieldName] = value;
  }

  const nicknameTemplate = getStringOption(interaction, "nickname_template");
  const clearNicknameTemplate = Boolean(getBooleanOption(interaction, "clear_nickname_template"));
  if (clearNicknameTemplate) {
    update.nicknameTemplate = null;
  } else if (nicknameTemplate !== null) {
    update.nicknameTemplate = nicknameTemplate;
  }

  const syncIntervalMinutes = getIntegerOption(interaction, "sync_interval_minutes");
  const clearSyncIntervalMinutes = Boolean(
    getBooleanOption(interaction, "clear_sync_interval_minutes"),
  );
  if (clearSyncIntervalMinutes) {
    update.syncIntervalMinutes = null;
  } else if (syncIntervalMinutes !== null) {
    update.syncIntervalMinutes = syncIntervalMinutes;
  }

  const verifiedRoleId = getRoleOptionId(interaction, "verified_role");
  const clearVerifiedRole = Boolean(getBooleanOption(interaction, "clear_verified_role"));
  if (clearVerifiedRole) {
    update.verifiedRoleId = null;
  } else if (verifiedRoleId !== null) {
    update.verifiedRoleId = verifiedRoleId;
  }

  const familyRoleId = getRoleOptionId(interaction, "family_role");
  const clearFamilyRole = Boolean(getBooleanOption(interaction, "clear_family_role"));
  if (clearFamilyRole) {
    update.familyRoleId = null;
  } else if (familyRoleId !== null) {
    update.familyRoleId = familyRoleId;
  }

  const cwlClanRoleId = getRoleOptionId(interaction, "cwl_clan_role");
  const clearCwlClanRole = Boolean(getBooleanOption(interaction, "clear_cwl_clan_role"));
  if (clearCwlClanRole) {
    update.cwlClanRoleId = null;
  } else if (cwlClanRoleId !== null) {
    update.cwlClanRoleId = cwlClanRoleId;
  }

  const nonMemberRoleId = getRoleOptionId(interaction, "non-member-role");
  if (nonMemberRoleId !== null) {
    update.nonMemberRoleId = nonMemberRoleId;
  }

  const nonMemberEnabled = getBooleanOption(interaction, "non-member-enabled");
  if (nonMemberEnabled !== null) {
    update.nonMemberEnabled = nonMemberEnabled;
  }

  const clanRoleRemovalDelayMinutes = getIntegerOption(interaction, "clan_role_removal_delay_minutes");
  const clearClanRoleRemovalDelay = Boolean(
    getBooleanOption(interaction, "clear_clan_role_removal_delay"),
  );
  if (clearClanRoleRemovalDelay) {
    update.clanRoleRemovalDelayMinutes = null;
  } else if (clanRoleRemovalDelayMinutes !== null) {
    update.clanRoleRemovalDelayMinutes = clanRoleRemovalDelayMinutes;
  }

  return update;
}

function buildRuleCreateInput(
  interaction: ChatInputCommandInteraction,
): AutoRoleRuleCreateInput {
  const type = interaction.options.getString("type", true) as AutoRoleRuleCreateInput["type"];
  const role = interaction.options.getRole("role", true);
  if (!role || !("id" in role)) {
    throw new Error("Selected Discord role is invalid.");
  }

  return {
    type,
    discordRoleId: role.id,
    targetValue: getStringOption(interaction, "target_value"),
    priority: getIntegerOption(interaction, "priority"),
    enabled: getBooleanOption(interaction, "enabled"),
  };
}

function buildRuleUpdateInput(
  interaction: ChatInputCommandInteraction,
): AutoRoleRuleUpdateInput {
  const input: AutoRoleRuleUpdateInput = {};
  const type = getStringOption(interaction, "type");
  if (type) input.type = type as AutoRoleRuleUpdateInput["type"];

  const role = interaction.options.getRole("role", false);
  if (role && "id" in role) {
    input.discordRoleId = role.id;
  }

  const targetValue = getStringOption(interaction, "target_value");
  if (targetValue !== null) input.targetValue = targetValue;

  const priority = getIntegerOption(interaction, "priority");
  if (priority !== null) input.priority = priority;

  const enabled = getBooleanOption(interaction, "enabled");
  if (enabled !== null) input.enabled = enabled;

  return input;
}

function buildSuccessContent(action: string): string {
  return `Autorole ${action}.`;
}

function formatRoleMentions(roleIds: string[]): string {
  if (roleIds.length === 0) return "none";
  return roleIds.map((roleId) => `<@&${roleId}>`).join(", ");
}

function formatRefreshSummary(result: AutoRoleRefreshResult): string {
  const scopeLabel =
    result.scope.kind === "guild"
      ? "guild"
      : result.scope.kind === "user"
        ? `<@${result.scope.discordUserId}>`
        : `<@&${result.scope.discordRoleId}>`;
  const lines = [
    `Autorole refresh completed for ${scopeLabel}.`,
    `Evaluated: ${result.evaluatedCount}. Added: ${result.addedCount}. Removed: ${result.removedCount}. Skipped: ${result.skippedCount}. Failed: ${result.failedCount}.`,
  ];

  if (result.scope.kind === "user" && result.memberResults.length > 0) {
    const member = result.memberResults[0];
    lines.push(`Roles added: ${formatRoleMentions(member.rolesAdded)}.`);
    lines.push(`Roles removed: ${formatRoleMentions(member.rolesRemoved)}.`);
    lines.push(`Nickname: ${member.nicknameStatus}${member.nicknameReason ? ` (${member.nicknameReason})` : ""}.`);
    if (member.skipReason) {
      lines.push(`Skipped reason: ${member.skipReason}.`);
    }
    if (member.failureReasons.length > 0) {
      lines.push(`Failures: ${member.failureReasons.join(" | ")}.`);
    }
  }

  return lines.join("\n");
}

export const Autorole: Command = {
  name: "autorole",
  description: "Manage autorole refresh, config, rules, exclusions, and nickname templates",
  options: [
    {
      name: "refresh",
      description: "Manually refresh autorole evaluation and Discord writes",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "user",
          description: "Discord user to refresh",
          type: ApplicationCommandOptionType.User,
          required: false,
        },
        {
          name: "role",
          description: "Managed Discord role to refresh",
          type: ApplicationCommandOptionType.Role,
          required: false,
        },
      ],
    },
    {
      name: "config",
      description: "View and update guild autorole config",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "show",
          description: "Show the current guild autorole config",
          type: ApplicationCommandOptionType.Subcommand,
        },
        {
          name: "set",
          description: "Update one or more guild autorole config fields",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            { name: "enabled", description: "Enable autorole", type: ApplicationCommandOptionType.Boolean, required: false },
            { name: "kill_switch_enabled", description: "Block future live writes", type: ApplicationCommandOptionType.Boolean, required: false },
            { name: "remove_stale_managed_roles", description: "Remove managed roles when they no longer qualify", type: ApplicationCommandOptionType.Boolean, required: false },
            { name: "apply_nicknames", description: "Enable nickname sync", type: ApplicationCommandOptionType.Boolean, required: false },
            { name: "nickname_template", description: "Nickname template text", type: ApplicationCommandOptionType.String, required: false },
            { name: "clear_nickname_template", description: "Clear the nickname template", type: ApplicationCommandOptionType.Boolean, required: false },
            { name: "trusted_links_allowed", description: "Allow trusted links to drive autorole", type: ApplicationCommandOptionType.Boolean, required: false },
            { name: "verified_only_mode", description: "Require verified links for autorole", type: ApplicationCommandOptionType.Boolean, required: false },
            { name: "sync_enabled", description: "Enable scheduled sync", type: ApplicationCommandOptionType.Boolean, required: false },
            { name: "sync_interval_minutes", description: "Scheduled sync interval in minutes", type: ApplicationCommandOptionType.Integer, required: false },
            { name: "clear_sync_interval_minutes", description: "Clear the sync interval", type: ApplicationCommandOptionType.Boolean, required: false },
            { name: "verified_role", description: "Role used for verified links", type: ApplicationCommandOptionType.Role, required: false },
            { name: "clear_verified_role", description: "Clear the verified role", type: ApplicationCommandOptionType.Boolean, required: false },
            { name: "family_role", description: "Role used for family/member links", type: ApplicationCommandOptionType.Role, required: false },
            { name: "clear_family_role", description: "Clear the family role", type: ApplicationCommandOptionType.Boolean, required: false },
            { name: "cwl_clan_role", description: "Role used for active current-season CWL clan members", type: ApplicationCommandOptionType.Role, required: false },
            { name: "clear_cwl_clan_role", description: "Clear the CWL clan role", type: ApplicationCommandOptionType.Boolean, required: false },
            { name: "non-member-role", description: "Role used for non-member/visitor autorole", type: ApplicationCommandOptionType.Role, required: false },
            { name: "non-member-enabled", description: "Enable or disable visitor autorole without clearing the saved role", type: ApplicationCommandOptionType.Boolean, required: false },
            { name: "clan_role_removal_delay_minutes", description: "Delay stale CLAN role removal in minutes", type: ApplicationCommandOptionType.Integer, required: false },
            { name: "clear_clan_role_removal_delay", description: "Clear the clan role removal delay", type: ApplicationCommandOptionType.Boolean, required: false },
          ],
        },
      ],
    },
    {
      name: "rules",
      description: "Manage autorole rule mappings",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "list",
          description: "List guild autorole rules",
          type: ApplicationCommandOptionType.Subcommand,
        },
        {
          name: "add",
          description: "Create a new autorole rule",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "type",
              description: "Rule type",
              type: ApplicationCommandOptionType.String,
              required: true,
              choices: AUTOROLE_RULE_TYPE_CHOICES,
            },
            {
              name: "role",
              description: "Discord role to manage",
              type: ApplicationCommandOptionType.Role,
              required: true,
            },
            {
              name: "target_value",
              description: "Rule target value (tag, rank, TH number, label id)",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
            {
              name: "priority",
              description: "Lower priority values run first",
              type: ApplicationCommandOptionType.Integer,
              required: false,
            },
            {
              name: "enabled",
              description: "Enable the rule immediately",
              type: ApplicationCommandOptionType.Boolean,
              required: false,
            },
          ],
        },
        {
          name: "edit",
          description: "Edit one autorole rule",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "rule_id",
              description: "Rule id to edit",
              type: ApplicationCommandOptionType.String,
              required: true,
            },
            {
              name: "type",
              description: "New rule type",
              type: ApplicationCommandOptionType.String,
              required: false,
              choices: AUTOROLE_RULE_TYPE_CHOICES,
            },
            {
              name: "role",
              description: "New Discord role to manage",
              type: ApplicationCommandOptionType.Role,
              required: false,
            },
            {
              name: "target_value",
              description: "New target value",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
            {
              name: "priority",
              description: "New priority",
              type: ApplicationCommandOptionType.Integer,
              required: false,
            },
            {
              name: "enabled",
              description: "Enable or disable the rule",
              type: ApplicationCommandOptionType.Boolean,
              required: false,
            },
          ],
        },
        {
          name: "remove",
          description: "Delete one autorole rule",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "rule_id",
              description: "Rule id to remove",
              type: ApplicationCommandOptionType.String,
              required: true,
            },
          ],
        },
      ],
    },
    {
      name: "exclusions",
      description: "Manage autorole user and role exclusions",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "list",
          description: "List user and role exclusions",
          type: ApplicationCommandOptionType.Subcommand,
        },
        {
          name: "add-user",
          description: "Exclude one user from autorole",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "user",
              description: "Discord user to exclude",
              type: ApplicationCommandOptionType.User,
              required: true,
            },
            {
              name: "reason",
              description: "Optional exclusion reason",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
          ],
        },
        {
          name: "remove-user",
          description: "Remove one user exclusion",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "user",
              description: "Discord user to remove from exclusions",
              type: ApplicationCommandOptionType.User,
              required: true,
            },
          ],
        },
        {
          name: "add-role",
          description: "Exclude one Discord role from autorole",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "role",
              description: "Discord role to exclude",
              type: ApplicationCommandOptionType.Role,
              required: true,
            },
            {
              name: "reason",
              description: "Optional exclusion reason",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
          ],
        },
        {
          name: "remove-role",
          description: "Remove one role exclusion",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "role",
              description: "Discord role to remove from exclusions",
              type: ApplicationCommandOptionType.Role,
              required: true,
            },
          ],
        },
      ],
    },
  ],
  run: async (_client: Client, interaction: ChatInputCommandInteraction, _cocService: CoCService) => {
    if (!interaction.inGuild() || !interaction.guildId) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "This command can only be used in a server.",
      });
      return;
    }

    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(true);
    const permissionService = new CommandPermissionService();

    const refreshUser = interaction.options.getUser("user", false);
    const refreshRole = interaction.options.getRole("role", false);
    const isRefresh = subcommand === "refresh" && group === null;

    if (isRefresh) {
      const canRunRefresh = await permissionService.canUseCommand("autorole:refresh", interaction);
      if (!canRunRefresh) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "You do not have permission to use /autorole.",
        });
        return;
      }
    } else if (!hasAdministratorPermission(interaction)) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "You do not have permission to use /autorole.",
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;

    try {
      if (subcommand === "refresh" && group === null) {
        const user = refreshUser;
        const role = refreshRole;
        if (user && role) {
          await interaction.editReply({
            content: "Please choose either user or role for /autorole refresh, not both.",
          });
          return;
        }

        if (!interaction.guild) {
          await interaction.editReply({
            content: "This command can only be used in a server.",
          });
          return;
        }

        const result = user
          ? await autoRoleRefreshService.refreshUser({
              guild: interaction.guild,
              guildId,
              discordUserId: user.id,
              cocService: _cocService,
            })
          : role
            ? await autoRoleRefreshService.refreshRole({
                guild: interaction.guild,
                guildId,
                discordRoleId: role.id,
                cocService: _cocService,
              })
            : await autoRoleRefreshService.refreshGuild({
                guild: interaction.guild,
                guildId,
                cocService: _cocService,
              });

        await interaction.editReply({
          content: formatRefreshSummary(result),
        });
        return;
      }

      if (group === "config") {
        if (subcommand === "show") {
          const config = await autoRoleService.getOrCreateGuildConfig(guildId);
          const visitorRolePresence = await resolveRolePresence(interaction.guild, config.nonMemberRoleId);
          await interaction.editReply({ embeds: [buildConfigEmbed(config, { visitorRolePresence })] });
          return;
        }

        if (subcommand === "set") {
          const config = await autoRoleService.updateGuildConfig(
            guildId,
            buildConfigUpdateInput(interaction),
          );
          const visitorRolePresence = await resolveRolePresence(interaction.guild, config.nonMemberRoleId);
          await interaction.editReply({
            content: buildSuccessContent("config updated"),
            embeds: [buildConfigEmbed(config, { visitorRolePresence })],
          });
          return;
        }
      }

      if (group === "rules") {
        if (subcommand === "list") {
          const rules = await autoRoleService.listRules(guildId);
          await replyPagedLines(interaction, "Autorole Rules", buildRuleLines(rules));
          return;
        }

        if (subcommand === "add") {
          const rule = await autoRoleService.createRule(
            guildId,
            buildRuleCreateInput(interaction),
          );
          const rules = await autoRoleService.listRules(guildId);
          await replyPagedLines(
            interaction,
            "Autorole Rules",
            buildRuleLines(rules),
            `Autorole rule added: \`${rule.id}\`.`,
          );
          return;
        }

        if (subcommand === "edit") {
          const ruleId = interaction.options.getString("rule_id", true);
          const rule = await autoRoleService.updateRule(
            guildId,
            ruleId,
            buildRuleUpdateInput(interaction),
          );
          if (!rule) {
            await interaction.editReply({
              content: `No autorole rule found for id ${ruleId}.`,
            });
            return;
          }
          const rules = await autoRoleService.listRules(guildId);
          await replyPagedLines(
            interaction,
            "Autorole Rules",
            buildRuleLines(rules),
            `Autorole rule updated: \`${rule.id}\`.`,
          );
          return;
        }

        if (subcommand === "remove") {
          const ruleId = interaction.options.getString("rule_id", true);
          const deleted = await autoRoleService.deleteRule(guildId, ruleId);
          if (!deleted) {
            await interaction.editReply({
              content: `No autorole rule found for id ${ruleId}.`,
            });
            return;
          }
          const rules = await autoRoleService.listRules(guildId);
          await replyPagedLines(
            interaction,
            "Autorole Rules",
            buildRuleLines(rules),
            `Autorole rule removed: \`${ruleId}\`.`,
          );
          return;
        }
      }

      if (group === "exclusions") {
        if (subcommand === "list") {
          const exclusions = await autoRoleService.listExclusions(guildId);
          await replyPagedLines(interaction, "Autorole Exclusions", buildExclusionLines(exclusions));
          return;
        }

        if (subcommand === "add-user") {
          const user = interaction.options.getUser("user", true);
          const reason = interaction.options.getString("reason", false);
          const row = await autoRoleService.addUserExclusion(guildId, user.id, reason);
          const exclusions = await autoRoleService.listExclusions(guildId);
          await replyPagedLines(
            interaction,
            "Autorole Exclusions",
            buildExclusionLines(exclusions),
            `Autorole user exclusion added: <@${row.discordUserId}>.`,
          );
          return;
        }

        if (subcommand === "remove-user") {
          const user = interaction.options.getUser("user", true);
          const deleted = await autoRoleService.removeUserExclusion(guildId, user.id);
          if (!deleted) {
            await interaction.editReply({
              content: `No autorole user exclusion found for <@${user.id}>.`,
            });
            return;
          }
          const exclusions = await autoRoleService.listExclusions(guildId);
          await replyPagedLines(
            interaction,
            "Autorole Exclusions",
            buildExclusionLines(exclusions),
            `Autorole user exclusion removed: <@${user.id}>.`,
          );
          return;
        }

        if (subcommand === "add-role") {
          const role = interaction.options.getRole("role", true);
          if (!role || !("id" in role)) {
            await interaction.editReply({ content: "Invalid role selected." });
            return;
          }
          const reason = interaction.options.getString("reason", false);
          const row = await autoRoleService.addRoleExclusion(guildId, role.id, reason);
          const exclusions = await autoRoleService.listExclusions(guildId);
          await replyPagedLines(
            interaction,
            "Autorole Exclusions",
            buildExclusionLines(exclusions),
            `Autorole role exclusion added: <@&${row.discordRoleId}>.`,
          );
          return;
        }

        if (subcommand === "remove-role") {
          const role = interaction.options.getRole("role", true);
          if (!role || !("id" in role)) {
            await interaction.editReply({ content: "Invalid role selected." });
            return;
          }
          const deleted = await autoRoleService.removeRoleExclusion(guildId, role.id);
          if (!deleted) {
            await interaction.editReply({
              content: `No autorole role exclusion found for <@&${role.id}>.`,
            });
            return;
          }
          const exclusions = await autoRoleService.listExclusions(guildId);
          await replyPagedLines(
            interaction,
            "Autorole Exclusions",
            buildExclusionLines(exclusions),
            `Autorole role exclusion removed: <@&${role.id}>.`,
          );
          return;
        }
      }

      await interaction.editReply({
        content: "Unknown autorole subcommand.",
      });
    } catch (error) {
      await interaction.editReply({
        content: `Autorole command failed: ${formatError(error)}`,
      });
    }
  },
};
