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

const COMMAND_CHOICES = COMMAND_PERMISSION_TARGETS.map((name) => ({
  name,
  value: name,
}));
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
          choices: COMMAND_CHOICES,
        },
        {
          name: "role",
          description: "Role to allow",
          type: ApplicationCommandOptionType.Role,
          required: true,
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
          choices: COMMAND_CHOICES,
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
          choices: COMMAND_CHOICES,
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
          : await permissionService.getPolicySummary(commandInput);
        await safeReply(interaction, {
          ephemeral: true,
          content: `\`/${commandInput}\` roles:\n${summary}`,
        });
        return;
      }

      const allLines: string[] = [];
      for (const target of COMMAND_PERMISSION_TARGETS) {
        const summary = await permissionService.getPolicySummary(target);
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

    const role = interaction.options.getRole("role", true);
    if (!("id" in role)) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Invalid role selected.",
      });
      return;
    }

    if (subcommand === "add") {
      const next = await permissionService.addAllowedRoleId(commandInput, role.id);
      await safeReply(interaction, {
        ephemeral: true,
        content:
          `Added <@&${role.id}> to \`/${commandInput}\`.\n` +
          `Allowed roles: ${formatRoleList(next)}`,
      });
      return;
    }

    if (subcommand === "remove") {
      const next = await permissionService.removeAllowedRoleId(commandInput, role.id);
      const summary = next.length
        ? `Allowed roles: ${formatRoleList(next)}`
        : await permissionService.getPolicySummary(commandInput);
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
};
