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
  GuildMember,
  Role,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { CoCService } from "../services/CoCService";

const PAGE_SIZE = 25;

function buildPages(role: Role): string[] {
  const members = [...role.members.values()];
  if (members.length === 0) return ["No members in role."];

  const pages: string[] = [];
  for (let i = 0; i < members.length; i += PAGE_SIZE) {
    const slice = members.slice(i, i + PAGE_SIZE);
    const text = slice
      .map((member: GuildMember) => `${member.displayName} [${member}]`)
      .join("\n");
    pages.push(text.length > 4000 ? `${text.slice(0, 3997)}...` : text);
  }
  return pages;
}

function getRow(page: number, pageCount: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("role-users-prev")
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId("role-users-next")
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount - 1),
    new ButtonBuilder()
      .setCustomId("role-users-print")
      .setLabel("Print")
      .setStyle(ButtonStyle.Primary)
  );
}

function getEmbed(
  interaction: ChatInputCommandInteraction,
  role: Role,
  pageText: string,
  page: number,
  pageCount: number
) {
  const embed = new EmbedBuilder()
    .setTitle(`${role.members.size} Users in ${role.name}`)
    .setDescription(pageText)
    .setColor(0x57f287)
    .setFooter({ text: `Page ${page + 1}/${pageCount}` });

  const guildIcon = interaction.guild?.iconURL();
  if (guildIcon) {
    embed.setThumbnail(guildIcon);
  }

  return embed;
}

export const RoleUsers: Command = {
  name: "role-users",
  description: "Get a list of users in a role",
  options: [
    {
      name: "role",
      description: "Discord role to inspect",
      type: ApplicationCommandOptionType.Role,
      required: true,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    try {
      if (!interaction.guild) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();

      // Best effort cache warm-up; don't fail command if this rejects.
      try {
        await interaction.guild.members.fetch();
      } catch (err) {
        console.warn(
          `role-users: guild.members.fetch failed, using cached role members: ${formatError(err)}`
        );
      }

      const role = interaction.options.getRole("role", true);
      if (!(role instanceof Role)) {
        await interaction.editReply("Invalid role selected.");
        return;
      }

      const pages = buildPages(role);
      let page = 0;

      await interaction.editReply({
        embeds: [getEmbed(interaction, role, pages[page], page, pages.length)],
        components: pages.length > 1 ? [getRow(page, pages.length)] : [],
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

          if (button.customId === "role-users-prev" && page > 0) {
            page -= 1;
          } else if (
            button.customId === "role-users-next" &&
            page < pages.length - 1
          ) {
            page += 1;
          } else if (button.customId === "role-users-print") {
            if (!interaction.channel) {
              await button.reply({
                content: "Could not print pages in this channel.",
                ephemeral: true,
              });
              return;
            }

            await button.update({ components: [] });
            for (let i = 0; i < pages.length; i += 1) {
              await interaction.channel.send({
                embeds: [getEmbed(interaction, role, pages[i], i, pages.length)],
              });
            }
            collector.stop("printed");
            return;
          }

          await button.update({
            embeds: [getEmbed(interaction, role, pages[page], page, pages.length)],
            components: [getRow(page, pages.length)],
          });
        } catch (err) {
          console.error(`role-users button handler failed: ${formatError(err)}`);
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
          await interaction.editReply({
            components: [],
          });
        } catch {
          // message might have been deleted; no-op
        }
      });
    } catch (err) {
      console.error(`role-users command failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "Failed to list role users.",
          ephemeral: true,
        });
      } else {
        await interaction.editReply("Failed to list role users.");
      }
    }
  },
};
