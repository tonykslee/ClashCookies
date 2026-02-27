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
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import {
  COMMAND_PERMISSION_TARGETS,
  CommandPermissionService,
  MANAGE_COMMAND_ROLES_COMMAND,
} from "../services/CommandPermissionService";
const LIST_PAGE_SIZE = 8;
const LIST_PREV_ID = "permission-list-prev";
const LIST_NEXT_ID = "permission-list-next";

function isPermissionTarget(value: string): value is (typeof COMMAND_PERMISSION_TARGETS)[number] {
  return (COMMAND_PERMISSION_TARGETS as readonly string[]).includes(value);
}

function formatRoleList(roleIds: string[]): string {
  if (roleIds.length === 0) return "(none)";
  return roleIds.map((id) => `<@&${id}>`).join(", ");
}

function getRoleIdsForAdd(interaction: ChatInputCommandInteraction): string[] {
  const optionNames = ["role", "role2", "role3", "role4", "role5"];
  const roleIds: string[] = [];
  for (const name of optionNames) {
    const role = interaction.options.getRole(name, name === "role");
    if (role && "id" in role) {
      roleIds.push(role.id);
    }
  }
  return [...new Set(roleIds)];
}

function getListRow(page: number, pageCount: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(LIST_PREV_ID)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(LIST_NEXT_ID)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount - 1)
  );
}

function getListEmbed(
  interaction: ChatInputCommandInteraction,
  lines: string[],
  page: number,
  pageCount: number
) {
  const embed = new EmbedBuilder()
    .setTitle("Command Role Permissions")
    .setDescription(lines.join("\n"))
    .setColor(0x5865f2)
    .setFooter({ text: `Page ${page + 1}/${pageCount}` });

  const guildIcon = interaction.guild?.iconURL();
  if (guildIcon) {
    embed.setThumbnail(guildIcon);
  }

  return embed;
}

export const CommandRole: Command = {
  name: MANAGE_COMMAND_ROLES_COMMAND,
  description: "Set which roles can use each command",
  options: [
    {
      name: "add",
      description: "Allow a role to use a command",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "command",
          description: "Command to restrict",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "role",
          description: "Role to allow",
          type: ApplicationCommandOptionType.Role,
          required: true,
        },
        {
          name: "role2",
          description: "Second role to allow (optional)",
          type: ApplicationCommandOptionType.Role,
          required: false,
        },
        {
          name: "role3",
          description: "Third role to allow (optional)",
          type: ApplicationCommandOptionType.Role,
          required: false,
        },
        {
          name: "role4",
          description: "Fourth role to allow (optional)",
          type: ApplicationCommandOptionType.Role,
          required: false,
        },
        {
          name: "role5",
          description: "Fifth role to allow (optional)",
          type: ApplicationCommandOptionType.Role,
          required: false,
        },
      ],
    },
    {
      name: "remove",
      description: "Remove a role from a command whitelist",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "command",
          description: "Command to update",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "role",
          description: "Role to remove",
          type: ApplicationCommandOptionType.Role,
          required: true,
        },
      ],
    },
    {
      name: "list",
      description: "List role policy for one or all commands",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "command",
          description: "Command or subcommand target (omit to list all)",
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
    _cocService: CoCService
  ) => {
    if (!interaction.inGuild()) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "This command can only be used in a server.",
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const permissionService = new CommandPermissionService();
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "list") {
      const commandInput = interaction.options.getString("command", false);
      if (commandInput && !isPermissionTarget(commandInput)) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "Unknown command target.",
        });
        return;
      }

      if (commandInput) {
        const roleIds = await permissionService.getAllowedRoleIds(commandInput);
        const summary = roleIds.length
          ? `Whitelisted roles: ${formatRoleList(roleIds)}`
          : await permissionService.getPolicySummary(commandInput, interaction.guildId);
        await safeReply(interaction, {
          ephemeral: true,
          content: `\`/${commandInput}\` roles:\n${summary}`,
        });
        return;
      }

      const allLines: string[] = [];
      const fwaLeaderRoleId = await permissionService.getFwaLeaderRoleId(interaction.guildId);
      if (!fwaLeaderRoleId) {
        allLines.push(
          "⚠️ `fwa-leader-role` is not set. Leader-default commands currently require Administrator. Use `/set fwa-leader-role`."
        );
      }
      for (const target of COMMAND_PERMISSION_TARGETS) {
        const summary = await permissionService.getPolicySummary(target, interaction.guildId);
        allLines.push(`- \`/${target}\`: ${summary}`);
      }

      if (allLines.length === 0) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "No commands found.",
        });
        return;
      }

      const pages: string[][] = [];
      for (let i = 0; i < allLines.length; i += LIST_PAGE_SIZE) {
        pages.push(allLines.slice(i, i + LIST_PAGE_SIZE));
      }

      let page = 0;
      await interaction.editReply({
        embeds: [getListEmbed(interaction, pages[page], page, pages.length)],
        components: pages.length > 1 ? [getListRow(page, pages.length)] : [],
      });

      if (pages.length <= 1) return;

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

          if (button.customId === LIST_PREV_ID && page > 0) {
            page -= 1;
          } else if (button.customId === LIST_NEXT_ID && page < pages.length - 1) {
            page += 1;
          }

          await button.update({
            embeds: [getListEmbed(interaction, pages[page], page, pages.length)],
            components: [getListRow(page, pages.length)],
          });
        } catch (err) {
          console.error(`permission list paginator failed: ${formatError(err)}`);
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
      return;
    }

    const commandInput = interaction.options.getString("command", true);
    if (!isPermissionTarget(commandInput)) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Unknown command target.",
      });
      return;
    }

    if (subcommand === "add") {
      const roleIds = getRoleIdsForAdd(interaction);
      if (roleIds.length === 0) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "Please provide at least one valid role.",
        });
        return;
      }

      let next = await permissionService.getAllowedRoleIds(commandInput);
      for (const roleId of roleIds) {
        next = await permissionService.addAllowedRoleId(commandInput, roleId);
      }

      const addedText = roleIds.map((id) => `<@&${id}>`).join(", ");
      await safeReply(interaction, {
        ephemeral: true,
        content:
          `Added ${addedText} to \`/${commandInput}\`.\n` +
          `Allowed roles: ${formatRoleList(next)}`,
      });
      return;
    }

    const role = interaction.options.getRole("role", true);
    if (!("id" in role)) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Invalid role selected.",
      });
      return;
    }

    if (subcommand === "remove") {
      const next = await permissionService.removeAllowedRoleId(commandInput, role.id);
      const summary = next.length
        ? `Allowed roles: ${formatRoleList(next)}`
        : await permissionService.getPolicySummary(commandInput, interaction.guildId);
      await safeReply(interaction, {
        ephemeral: true,
        content:
          `Removed <@&${role.id}> from \`/${commandInput}\`.\n` +
          summary,
      });
      return;
    }

    await safeReply(interaction, {
      ephemeral: true,
      content: "Unknown subcommand.",
    });
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "command") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "").trim().toLowerCase();
    const targets = [...COMMAND_PERMISSION_TARGETS];
    const starts = targets.filter((t) => t.toLowerCase().startsWith(query));
    const contains = targets.filter(
      (t) =>
        !t.toLowerCase().startsWith(query) && t.toLowerCase().includes(query)
    );

    await interaction.respond(
      [...starts, ...contains].slice(0, 25).map((t) => ({ name: t, value: t }))
    );
  },
};
