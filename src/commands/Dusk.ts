import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import { DuskLedgerEntry, DuskLedgerTransactionType } from "@prisma/client";
import { Command } from "../Command";
import { CoCService } from "../services/CoCService";
import {
  DuskLedgerEntryCursor,
  DuskLedgerEntryPage,
  duskLedgerService,
} from "../services/DuskLedgerService";

const RECENT_ENTRY_LIMIT = 5;
const HISTORY_PAGE_SIZE = 8;
const HISTORY_MAX_PAGES = 50;
const HISTORY_TIMEOUT_MS = 10 * 60 * 1000;

function formatAmount(amount: number): string {
  return amount > 0 ? `+${amount}` : String(amount);
}

function transactionLabel(transactionType: DuskLedgerTransactionType): string {
  switch (transactionType) {
    case DuskLedgerTransactionType.EARNING:
      return "Earned";
    case DuskLedgerTransactionType.SPEND:
      return "Spent";
    case DuskLedgerTransactionType.CORRECTION:
      return "Correction";
    case DuskLedgerTransactionType.REVERSAL:
      return "Reversal";
    default:
      return "Transaction";
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function formatEntry(entry: DuskLedgerEntry): string {
  const timestamp = Math.floor(entry.createdAt.getTime() / 1000);
  const reason = truncate(entry.reason.replaceAll(/\s+/g, " ").trim(), 90);
  return `<t:${timestamp}:d> · **${transactionLabel(entry.transactionType)} ${formatAmount(entry.amount)}** · ${reason}`;
}

function buildWalletEmbed(input: {
  balance: number;
  lifetimeEarned: number;
  recentEntries: DuskLedgerEntry[];
}): EmbedBuilder {
  const recentTransactions = input.recentEntries.length
    ? input.recentEntries.map(formatEntry).join("\n")
    : "No transactions yet.";
  return new EmbedBuilder()
    .setTitle("Duskits Wallet")
    .setDescription("Duskits — alliance reward currency.")
    .addFields(
      { name: "Available balance", value: `${input.balance} Duskits`, inline: true },
      { name: "Lifetime earned", value: `${input.lifetimeEarned} Duskits`, inline: true },
      { name: "Recent transactions", value: truncate(recentTransactions, 1024) },
    );
}

function buildHistoryEmbed(page: DuskLedgerEntryPage, pageNumber: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Duskits history")
    .setDescription(
      page.entries.length
        ? page.entries.map(formatEntry).join("\n")
        : "No transactions yet.",
    )
    .setFooter({ text: `Page ${pageNumber}` });
}

function buildHistoryRow(
  customIdPrefix: string,
  pageNumber: number,
  page: DuskLedgerEntryPage,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:newer`)
      .setLabel("Newer")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageNumber <= 1),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:older`)
      .setLabel("Older")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!page.hasMore || pageNumber >= HISTORY_MAX_PAGES),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:wallet`)
      .setLabel("Wallet")
      .setStyle(ButtonStyle.Primary),
  );
}

function buildHistoryState(page: DuskLedgerEntryPage, before: DuskLedgerEntryCursor | null) {
  return { page, before };
}

async function replyToUnauthorizedButton(button: ButtonInteraction): Promise<void> {
  await button.reply({
    content: "This wallet history belongs to another user.",
    ephemeral: true,
  });
}

export const Dusk: Command = {
  name: "dusk",
  description: "View your private Duskits wallet and transaction history",
  suppressVisibilityOption: true,
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService,
  ) => {
    const discordUserId = interaction.user.id;
    await interaction.deferReply({ ephemeral: true });

    try {
      const [balance, lifetimeEarned, recentEntries] = await Promise.all([
        duskLedgerService.getBalance(discordUserId),
        duskLedgerService.getLifetimeEarned(discordUserId),
        duskLedgerService.listEntries(discordUserId, RECENT_ENTRY_LIMIT),
      ]);
      const walletEmbed = buildWalletEmbed({ balance, lifetimeEarned, recentEntries });
      const customIdPrefix = `dusk:${interaction.id}`;

      await interaction.editReply({
        embeds: [walletEmbed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`${customIdPrefix}:history`)
              .setLabel("View History")
              .setStyle(ButtonStyle.Primary),
          ),
        ],
        allowedMentions: { parse: [] },
      });

      const message = await interaction.fetchReply();
      if (!("createMessageComponentCollector" in message)) return;

      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: HISTORY_TIMEOUT_MS,
        filter: (button) => button.customId.startsWith(customIdPrefix),
      });
      const historyPages: Array<ReturnType<typeof buildHistoryState>> = [];

      collector.on("collect", async (button: ButtonInteraction) => {
        try {
          if (button.user.id !== discordUserId) {
            await replyToUnauthorizedButton(button);
            return;
          }

          if (button.customId === `${customIdPrefix}:history`) {
            const page = await duskLedgerService.listEntryPage(
              discordUserId,
              null,
              HISTORY_PAGE_SIZE,
            );
            historyPages.splice(0, historyPages.length, buildHistoryState(page, null));
            await button.update({
              embeds: [buildHistoryEmbed(page, 1)],
              components: [buildHistoryRow(customIdPrefix, 1, page)],
              allowedMentions: { parse: [] },
            });
            return;
          }

          if (button.customId === `${customIdPrefix}:wallet`) {
            await button.update({
              embeds: [walletEmbed],
              components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId(`${customIdPrefix}:history`)
                    .setLabel("View History")
                    .setStyle(ButtonStyle.Primary),
                ),
              ],
              allowedMentions: { parse: [] },
            });
            return;
          }

          if (!historyPages.length) return;
          if (button.customId === `${customIdPrefix}:older`) {
            const current = historyPages.at(-1)!;
            if (current.page.hasMore && current.page.nextCursor && historyPages.length < HISTORY_MAX_PAGES) {
              const page = await duskLedgerService.listEntryPage(
                discordUserId,
                current.page.nextCursor,
                HISTORY_PAGE_SIZE,
              );
              historyPages.push(buildHistoryState(page, current.page.nextCursor));
            }
          } else if (button.customId === `${customIdPrefix}:newer` && historyPages.length > 1) {
            historyPages.pop();
          } else {
            return;
          }

          const current = historyPages.at(-1)!;
          await button.update({
            embeds: [buildHistoryEmbed(current.page, historyPages.length)],
            components: [buildHistoryRow(customIdPrefix, historyPages.length, current.page)],
            allowedMentions: { parse: [] },
          });
        } catch {
          if (!button.replied && !button.deferred) {
            await button.reply({
              content: "Duskits wallet history is temporarily unavailable. Please try again later.",
              ephemeral: true,
            });
          }
        }
      });

      collector.on("end", async () => {
        await interaction.editReply({ components: [] }).catch(() => undefined);
      });
    } catch {
      await interaction.editReply({
        content: "Duskits wallet is temporarily unavailable. Please try again later.",
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      });
    }
  },
};
