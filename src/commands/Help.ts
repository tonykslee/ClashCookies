import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { Command } from "../Command";
import { Commands } from "../Commands";
import { formatError } from "../helper/formatError";

const OVERVIEW_PAGE_SIZE = 4;
const HELP_TIMEOUT_MS = 10 * 60 * 1000;
const HELP_POST_BUTTON_PREFIX = "help-post-channel";
const ADMIN_DEFAULT_TARGETS = new Set<string>([
  "tracked-clan:add",
  "tracked-clan:remove",
  "sheet:link",
  "sheet:unlink",
  "sheet:show",
  "sheet:refresh",
  "kick-list",
  "kick-list:build",
  "kick-list:add",
  "kick-list:remove",
  "kick-list:show",
  "kick-list:clear",
  "sync:time:post",
  "notify:war",
  "permission:add",
  "permission:remove",
]);

type CommandDoc = {
  summary: string;
  details: string[];
  examples: string[];
};

type HelpOption = {
  name: string;
  type: ApplicationCommandOptionType;
  required?: boolean;
  options?: HelpOption[];
};

const COMMAND_DOCS: Record<string, CommandDoc> = {
  help: {
    summary: "Browse command docs and examples.",
    details: [
      "Use pages for a quick command overview.",
      "Select any command to drill into syntax and example flows.",
      "Set `visibility:public` to post the help response directly in channel.",
    ],
    examples: ["/help", "/help command:sheet", "/help visibility:public"],
  },
  lastseen: {
    summary: "Estimate when a player was last active.",
    details: [
      "Reads stored activity first, then infers from live profile stats.",
      "Includes an Activity Breakdown button with localized timestamps for tracked signals.",
      "Stores inference for faster future lookups.",
    ],
    examples: ["/lastseen tag:ABC123XYZ"],
  },
  inactive: {
    summary: "List players inactive for a given number of days.",
    details: [
      "Shows oldest inactive players first.",
      "Supports `wars` mode to list tracked members who used 0/2 attacks in each of the last X ended wars.",
      "Large results are clipped to keep replies readable.",
    ],
    examples: ["/inactive days:7", "/inactive days:30", "/inactive wars:3"],
  },
  "role-users": {
    summary: "Show members in a role with paging controls.",
    details: [
      "Supports in-message pagination for large roles.",
      "Includes a print action to dump all pages in channel.",
    ],
    examples: ["/role-users role:@Leaders"],
  },
  "tracked-clan": {
    summary: "Manage tracked clans used by activity features.",
    details: [
      "Add/remove tracked clans or list current tracked set.",
      "Set clan lose-style on add (defaults to TRIPLE_TOP_30). Re-running add updates lose-style.",
      "`add` and `remove` are admin-only by default.",
    ],
    examples: [
      "/tracked-clan add tag:#2QG2C08UP",
      "/tracked-clan add tag:#2QG2C08UP lose-style:Traditional",
      "/tracked-clan remove tag:#2QG2C08UP",
      "/tracked-clan list",
    ],
  },
  sheet: {
    summary: "Link and manage Google Sheet settings.",
    details: [
      "Supports mode-specific links (`actual` and `war`).",
      "Refresh can trigger an Apps Script webhook per mode.",
      "`link`, `unlink`, `show`, and `refresh` are admin-only by default.",
    ],
    examples: [
      "/sheet link sheet_id_or_url:https://docs.google.com/... mode:actual",
      "/sheet show mode:war",
      "/sheet refresh mode:actual",
    ],
  },
  compo: {
    summary: "Composition tools backed by the AllianceDashboard sheet.",
    details: [
      "`advice`: fetch clan-specific adjustment notes.",
      "`state`: render state table as an image.",
      "`place`: suggest placement by war weight.",
    ],
    examples: [
      "/compo advice clan:Rising Dawn mode:actual",
      "/compo state mode:war",
      "/compo place weight:145k",
    ],
  },
  cc: {
    summary: "Build ClashChamps URLs for clans or players.",
    details: [
      "Tag accepts values with or without `#`.",
      "`clan` subcommand supports autocomplete from tracked clans.",
    ],
    examples: ["/cc player tag:ABCD1234", "/cc clan tag:2QG2C08UP"],
  },
  notify: {
    summary: "Configure notification features.",
    details: [
      "`war` enables war-state event embeds for a clan in a selected channel.",
      "`show` lists notify routing (channel/role/status) for tracked clans, optionally filtered by tag.",
      "`war-remove` removes a clan's war event subscription for this server.",
      "Optional `role` pings that role whenever a war event embed is posted.",
      "Works with clans outside tracked-clans table (tag must still be valid in CoC API).",
      "Posts at war start, battle day, and war end with opponent + points projection.",
    ],
    examples: [
      "/notify war clan-tag:2QG2C08UP target-channel:#war-events role:@Leaders",
      "/notify war clan-tag:2QG2C08UP target-channel:#new-war-events",
      "/notify war-remove clan-tag:2QG2C08UP",
      "/notify show",
      "/notify show clan-tag:2QG2C08UP",
    ],
  },
  war: {
    summary: "Query clan-level war history and export war attack payload by war ID.",
    details: [
      "`/war history` shows recent clan-level war summary rows from WarClanHistory.",
      "`/war war-id` exports the stored WarLookup payload as a CSV file for drill-down review.",
      "Use war IDs returned from `/war history` to retrieve detailed attack rows.",
    ],
    examples: [
      "/war history clan-tag:2QG2C08UP",
      "/war history clan-tag:2QG2C08UP limit:25",
      "/war war-id war-id:1000001",
    ],
  },
  accounts: {
    summary: "List linked player accounts grouped by their current clan.",
    details: [
      "Default behavior lists accounts linked to your Discord account.",
      "If `discord-id` is provided, lists accounts for that user.",
      "If `tag` is provided, resolves linked Discord ID from PlayerLink/ClashKing, then lists that user's accounts.",
      "Only one of `tag` or `discord-id` can be provided.",
      "If no local links are found for the target user, it queries ClashKing `/discord_links` and caches results to `PlayerLink`.",
      "Fetches live player data when available and groups accounts by current clan.",
      "Set `visibility:public` to post the response directly in channel.",
    ],
    examples: [
      "/accounts",
      "/accounts discord-id:143827744717799425",
      "/accounts tag:G2RG9JCRL",
      "/accounts visibility:public",
    ],
  },
  fwa: {
    summary: "FWA points and matchup tools.",
    details: [
      "`/fwa points` returns point balances (single clan tag or all tracked if tag omitted).",
      "`/fwa match` auto-resolves current war opponent from CoC API and evaluates win/lose/tiebreak using the same points logic.",
      "If match type is inferred, `/fwa match` shows a warning and quick verify link, with action buttons to confirm FWA/BL/MM.",
      "`/fwa leader-role` sets the default FWA leader role used by leader-only commands.",
      "Tag supports autocomplete from tracked clans.",
      "Set `visibility:public` to post the result directly in channel.",
    ],
    examples: [
      "/fwa points tag:2QG2C08UP",
      "/fwa points",
      "/fwa match tag:2QG2C08UP",
      "/fwa leader-role role:@FWA-Leaders",
      "/fwa points tag:2QG2C08UP visibility:public",
    ],
  },
  recruitment: {
    summary: "Manage recruitment templates and per-platform posting cooldowns.",
    details: [
      "`show` renders platform-specific recruitment output for a tracked clan.",
      "`edit` now requires platform and opens a platform-specific modal (discord/band/reddit fields differ).",
      "`countdown start` begins exact platform cooldown timers; `countdown status` shows your timers.",
      "`dashboard` summarizes readiness across all tracked clans and platforms for your account.",
    ],
    examples: [
      "/recruitment show platform:discord clan:2QG2C08UP",
      "/recruitment edit platform:reddit clan:2QG2C08UP",
      "/recruitment countdown start platform:reddit clan:2QG2C08UP",
      "/recruitment countdown status",
      "/recruitment dashboard",
    ],
  },
  "kick-list": {
    summary: "Build and manage kick-list candidates.",
    details: [
      "`build` auto-adds tracked-clan members who are inactive (default 3 days), unlinked, or linked to users not in this server.",
      "Results prioritize players who are both inactive and link-mismatched.",
      "`add` supports manual entries with a custom reason.",
      "`show` displays reasons for each candidate with pagination.",
    ],
    examples: [
      "/kick-list build",
      "/kick-list build days:5",
      "/kick-list add tag:#ABC123 reason:Missed war hits",
      "/kick-list show",
    ],
  },
  sync: {
    summary: "Post structured messages such as sync time announcements.",
    details: [
      "`/sync time post` opens a modal to capture date/time/timezone and role ping.",
      "Creates and pins a sync-time message in the active channel, then adds clan badge reactions.",
      "`/sync post status` shows claimed vs unclaimed clans from the stored active sync post, or a provided message ID.",
      "`sync time` is admin-only by default.",
    ],
    examples: ["/sync time post role:@War", "/sync post status", "/sync post status message-id:123456789012345678"],
  },
  permission: {
    summary: "Control which roles can run each command target.",
    details: [
      "Add/remove role whitelists for command targets.",
      "List current policy for one target or all targets.",
      "`add` and `remove` are admin-only by default.",
    ],
    examples: [
      "/permission add command:sync role:@Leaders",
      "/permission add command:fwa role:@Leaders",
      "/permission remove command:sync role:@Leaders",
      "/permission list",
    ],
  },
};

export function getHelpDocumentedCommandNames(): string[] {
  return Object.keys(COMMAND_DOCS).sort((a, b) => a.localeCompare(b));
}

type RenderState = {
  page: number;
  selectedCommand: string;
  detailView: boolean;
};

function getAllCommands(): Command[] {
  return [...Commands].sort((a, b) => a.name.localeCompare(b.name));
}

function getAdminDefaultTargetsForCommand(commandName: string): string[] {
  return [...ADMIN_DEFAULT_TARGETS]
    .filter((target) => target === commandName || target.startsWith(`${commandName}:`))
    .map((target) => `/${target.replaceAll(":", " ")}`);
}

function toOptionLabel(option: HelpOption): string {
  switch (option.type) {
    case ApplicationCommandOptionType.String:
      return "text";
    case ApplicationCommandOptionType.Integer:
      return "number";
    case ApplicationCommandOptionType.Number:
      return "decimal";
    case ApplicationCommandOptionType.Boolean:
      return "true|false";
    case ApplicationCommandOptionType.User:
      return "@user";
    case ApplicationCommandOptionType.Channel:
      return "#channel";
    case ApplicationCommandOptionType.Role:
      return "@role";
    case ApplicationCommandOptionType.Mentionable:
      return "@mention";
    case ApplicationCommandOptionType.Attachment:
      return "file";
    default:
      return "value";
  }
}

function formatOptionToken(option: HelpOption): string {
  const token = `${option.name}:${toOptionLabel(option)}`;
  return option.required ? `<${token}>` : `[${token}]`;
}

function buildUsageLines(command: Command): string[] {
  const options = (command.options ?? []) as HelpOption[];
  if (options.length === 0) return [`/${command.name}`];

  const lines: string[] = [];

  for (const option of options) {
    if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
      const subcommands = (option.options ?? []) as HelpOption[];
      for (const subcommand of subcommands) {
        const subOptions = (subcommand.options ?? []) as HelpOption[];
        const argTokens = subOptions.map(formatOptionToken).join(" ");
        lines.push(
          `/${command.name} ${option.name} ${subcommand.name}${argTokens ? ` ${argTokens}` : ""}`
        );
      }
      continue;
    }

    if (option.type === ApplicationCommandOptionType.Subcommand) {
      const subOptions = (option.options ?? []) as HelpOption[];
      const argTokens = subOptions.map(formatOptionToken).join(" ");
      lines.push(`/${command.name} ${option.name}${argTokens ? ` ${argTokens}` : ""}`);
      continue;
    }
  }

  if (lines.length > 0) return lines;

  const topLevelTokens = options.map(formatOptionToken).join(" ");
  return [`/${command.name}${topLevelTokens ? ` ${topLevelTokens}` : ""}`];
}

function getOverviewEmbed(commands: Command[], state: RenderState): EmbedBuilder {
  const pageCount = Math.max(1, Math.ceil(commands.length / OVERVIEW_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(state.page, pageCount - 1));
  const start = safePage * OVERVIEW_PAGE_SIZE;
  const slice = commands.slice(start, start + OVERVIEW_PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setTitle("Help Center")
    .setColor(0x5865f2)
    .setDescription("Use **Previous/Next** to browse pages, then pick a command from the dropdown for details.")
    .setFooter({ text: `Overview page ${safePage + 1}/${pageCount}` });

  for (const cmd of slice) {
    const usage = buildUsageLines(cmd)[0] ?? `/${cmd.name}`;
    embed.addFields({
      name: `/${cmd.name}`,
      value: `${cmd.description}\nExample: \`${usage}\``,
      inline: false,
    });
  }

  return embed;
}

function getDetailEmbed(command: Command): EmbedBuilder {
  const usageLines = buildUsageLines(command);
  const doc = COMMAND_DOCS[command.name];
  const adminDefaults = getAdminDefaultTargetsForCommand(command.name);

  const detailLines = doc?.details ?? [
    "Use this command to run the described operation.",
    "If this command has subcommands, use one of the syntax lines below.",
  ];

  const exampleLines = doc?.examples?.length ? doc.examples : [usageLines[0] ?? `/${command.name}`];

  const accessText =
    adminDefaults.length === 0
      ? "Default access: everyone (unless restricted with `/permission`)."
      : `Admin-only by default: ${adminDefaults.map((t) => `\`${t}\``).join(", ")}`;

  return new EmbedBuilder()
    .setTitle(`/${command.name}`)
    .setColor(0x57f287)
    .setDescription(doc?.summary ?? command.description)
    .addFields(
      {
        name: "What It Does",
        value: detailLines.map((line) => `- ${line}`).join("\n"),
        inline: false,
      },
      {
        name: "Syntax",
        value: usageLines.map((line) => `\`${line}\``).join("\n"),
        inline: false,
      },
      {
        name: "Examples",
        value: exampleLines.map((line) => `\`${line}\``).join("\n"),
        inline: false,
      },
      {
        name: "Access",
        value: `${accessText}\nUse \`/permission add\` to whitelist roles.`,
        inline: false,
      }
    )
    .setFooter({ text: "Select another command or click Back to overview." });
}

function getControls(
  commands: Command[],
  state: RenderState,
  interactionId: string,
  allowPostToChannel: boolean
) {
  const pageCount = Math.max(1, Math.ceil(commands.length / OVERVIEW_PAGE_SIZE));
  const prevId = `help-prev:${interactionId}`;
  const nextId = `help-next:${interactionId}`;
  const backId = `help-back:${interactionId}`;
  const closeId = `help-close:${interactionId}`;
  const postId = `${HELP_POST_BUTTON_PREFIX}:${interactionId}`;
  const selectId = `help-select:${interactionId}`;

  const buttonRow = new ActionRowBuilder<ButtonBuilder>();
  if (state.detailView) {
    buttonRow.addComponents(
      new ButtonBuilder().setCustomId(backId).setLabel("Back").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(closeId).setLabel("Close").setStyle(ButtonStyle.Danger)
    );
    if (allowPostToChannel) {
      buttonRow.addComponents(
        new ButtonBuilder()
          .setCustomId(postId)
          .setLabel("Post to Channel")
          .setStyle(ButtonStyle.Primary)
      );
    }
  } else {
    buttonRow.addComponents(
      new ButtonBuilder()
        .setCustomId(prevId)
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(state.page <= 0),
      new ButtonBuilder()
        .setCustomId(nextId)
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(state.page >= pageCount - 1),
      new ButtonBuilder().setCustomId(closeId).setLabel("Close").setStyle(ButtonStyle.Danger)
    );
    if (allowPostToChannel) {
      buttonRow.addComponents(
        new ButtonBuilder()
          .setCustomId(postId)
          .setLabel("Post to Channel")
          .setStyle(ButtonStyle.Primary)
      );
    }
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(selectId)
    .setPlaceholder("Drill down into a command")
    .addOptions(
      commands.slice(0, 25).map((cmd) => ({
        label: `/${cmd.name}`.slice(0, 100),
        description: cmd.description.slice(0, 100),
        value: cmd.name,
        default: cmd.name === state.selectedCommand,
      }))
    );

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  return [buttonRow, selectRow];
}

function getResponsePayload(
  commands: Command[],
  state: RenderState,
  interactionId: string,
  allowPostToChannel: boolean
) {
  const selected = commands.find((cmd) => cmd.name === state.selectedCommand) ?? commands[0];
  const embed = state.detailView ? getDetailEmbed(selected) : getOverviewEmbed(commands, state);
  const components = getControls(commands, state, interactionId, allowPostToChannel);
  return { embeds: [embed], components };
}

export const Help: Command = {
  name: "help",
  description: "Browse commands, examples, and usage details",
  options: [
    {
      name: "command",
      description: "Jump directly to one command",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: true,
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
  run: async (_client: Client, interaction: ChatInputCommandInteraction) => {
    const commands = getAllCommands();
    const requestedCommand = interaction.options.getString("command", false)?.trim().toLowerCase();
    const visibility = interaction.options.getString("visibility", false) ?? "private";
    const isPublic = visibility === "public";
    const allowPostToChannel = !isPublic;

    const state: RenderState = {
      page: 0,
      selectedCommand: commands[0]?.name ?? "help",
      detailView: false,
    };

    if (requestedCommand) {
      const match = commands.find((cmd) => cmd.name === requestedCommand);
      if (!match) {
        await interaction.reply({
          ephemeral: true,
          content: `Unknown command \`${requestedCommand}\`. Try \`/help\` and select from the list.`,
        });
        return;
      }

      state.detailView = true;
      state.selectedCommand = match.name;
      state.page = Math.floor(commands.findIndex((cmd) => cmd.name === match.name) / OVERVIEW_PAGE_SIZE);
    }

    await interaction.reply({
      ephemeral: !isPublic,
      ...getResponsePayload(commands, state, interaction.id, allowPostToChannel),
    });

    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
      time: HELP_TIMEOUT_MS,
    });

    collector.on(
      "collect",
      async (component: ButtonInteraction | StringSelectMenuInteraction) => {
        try {
          if (component.user.id !== interaction.user.id) {
            await component.reply({
              ephemeral: true,
              content: "Only the user who opened this help menu can use it.",
            });
            return;
          }

          if (component.isButton()) {
            if (component.customId === `help-prev:${interaction.id}` && state.page > 0) {
              state.page -= 1;
              state.detailView = false;
            } else if (
              component.customId === `help-next:${interaction.id}` &&
              state.page < Math.ceil(commands.length / OVERVIEW_PAGE_SIZE) - 1
            ) {
              state.page += 1;
              state.detailView = false;
            } else if (component.customId === `help-back:${interaction.id}`) {
              state.detailView = false;
            } else if (component.customId === `help-close:${interaction.id}`) {
              await component.update({
                content: "Help closed.",
                embeds: [],
                components: [],
              });
              collector.stop("closed");
              return;
            } else if (component.customId === `${HELP_POST_BUTTON_PREFIX}:${interaction.id}`) {
              const payload = getResponsePayload(
                commands,
                state,
                interaction.id,
                allowPostToChannel
              );
              await interaction.channel?.send({
                embeds: payload.embeds,
              });
              await component.reply({
                ephemeral: true,
                content: "Posted to channel.",
              });
              return;
            }
          } else if (component.isStringSelectMenu()) {
            const picked = component.values[0];
            const found = commands.find((cmd) => cmd.name === picked);
            if (found) {
              state.selectedCommand = found.name;
              state.detailView = true;
              state.page = Math.floor(
                commands.findIndex((cmd) => cmd.name === found.name) / OVERVIEW_PAGE_SIZE
              );
            }
          }

          await component.update(
            getResponsePayload(commands, state, interaction.id, allowPostToChannel)
          );
        } catch (err) {
          console.error(`help component handler failed: ${formatError(err)}`);
          try {
            if (!component.replied && !component.deferred) {
              await component.reply({
                ephemeral: true,
                content: "Failed to update help menu.",
              });
            }
          } catch {
            // no-op
          }
        }
      }
    );

    collector.on("end", async (_collected, reason) => {
      if (reason === "closed") return;

      try {
        await interaction.editReply({ components: [] });
      } catch {
        // no-op
      }
    });
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "command") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "").trim().toLowerCase();
    const names = getAllCommands().map((cmd) => cmd.name);
    const starts = names.filter((name) => name.startsWith(query));
    const contains = names.filter((name) => !name.startsWith(query) && name.includes(query));

    await interaction.respond(
      [...starts, ...contains].slice(0, 25).map((name) => ({
        name,
        value: name,
      }))
    );
  },
};
