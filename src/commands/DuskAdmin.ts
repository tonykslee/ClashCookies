import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  MessageComponentInteraction,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { DuskLedgerTransactionType } from "@prisma/client";
import { Command } from "../Command";
import { CoCService } from "../services/CoCService";
import {
  DuskAuditEntryPage,
  DuskAuditLedgerEntry,
  DuskAuditReversalRequest,
  DuskSourceEventAudit,
  duskLedgerService,
} from "../services/DuskLedgerService";
import { dozzleLog } from "../helper/dozzleLogger";

const AUDIT_PAGE_SIZE = 8;
const RECENT_ENTRY_LIMIT = 5;
const MAX_HISTORY_PAGES = 50;
const REVERSAL_PAGE_SIZE = 8;
const MAX_REVERSAL_PAGES = 7;
const AUDIT_TIMEOUT_MS = 10 * 60 * 1000;

type AdminInteractionEvidence = {
  inGuild?: () => boolean;
  guildId?: string | null;
  guild?: unknown | null;
  member?: unknown | null;
  memberPermissions?: { has: (permission: bigint) => boolean } | null;
};

type AuditMember = {
  id: string;
  displayName: string;
  username: string;
};

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function sanitize(value: unknown, maxLength = 240): string {
  const normalized = String(value ?? "")
    .replaceAll("@", "@\u200b")
    .replaceAll("```", "''' ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return truncate(normalized || "—", maxLength);
}

function safeJson(value: unknown, maxLength = 700): string {
  if (value === null || value === undefined) return "—";
  try {
    return sanitize(JSON.stringify(value), maxLength);
  } catch {
    return "UNKNOWN (unserializable provenance)";
  }
}

function formatAmount(amount: number): string {
  return amount > 0 ? `+${amount}` : String(amount);
}

function transactionLabel(transactionType: DuskLedgerTransactionType): string {
  switch (transactionType) {
    case DuskLedgerTransactionType.EARNING:
      return "EARNING";
    case DuskLedgerTransactionType.SPEND:
      return "SPEND";
    case DuskLedgerTransactionType.CORRECTION:
      return "CORRECTION";
    case DuskLedgerTransactionType.REVERSAL:
      return "REVERSAL";
    default:
      return "UNKNOWN";
  }
}

function formatTimestamp(value: Date): string {
  const timestamp = Math.floor(value.getTime() / 1000);
  return `<t:${timestamp}:f>`;
}

function formatEntryValue(entry: DuskAuditLedgerEntry): string {
  const lines = [
    `Type: ${transactionLabel(entry.transactionType)} · Amount: ${formatAmount(entry.amount)}`,
    `When: ${formatTimestamp(entry.createdAt)} · Reason: ${sanitize(entry.reason, 180)}`,
    `Actor: ${sanitize(entry.actorDiscordUserId, 80)} · Source: ${sanitize(entry.sourceEventType, 64)}:${sanitize(entry.sourceEventId, 120)}`,
    `Policy: ${sanitize(entry.policyVersion, 64)} · Original: ${sanitize(entry.reversalOfId, 80)}`,
    `Reversal(s): ${sanitize(entry.reversals.map((reversal) => reversal.id).join(", "), 160)}`,
  ];
  return truncate(lines.join("\n"), 1024);
}

function buildMemberLabel(member: AuditMember): string {
  return `${sanitize(member.displayName, 80)} (${sanitize(member.username, 80)}) · ID ${sanitize(member.id, 80)}`;
}

function addEntryFields(embed: EmbedBuilder, entries: DuskAuditLedgerEntry[]): void {
  if (entries.length === 0) {
    embed.addFields({ name: "Transactions", value: "No transactions recorded." });
    return;
  }
  entries.forEach((entry, index) => {
    embed.addFields({
      name: `${index + 1}. ${sanitize(entry.id, 100)}`,
      value: formatEntryValue(entry),
      inline: false,
    });
  });
}

function buildWalletEmbed(input: {
  member: AuditMember;
  balance: number;
  lifetimeEarned: number;
  entries: DuskAuditLedgerEntry[];
  reversalCount: number;
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Duskits administrator audit")
    .setDescription(`Target member: ${buildMemberLabel(input.member)}`)
    .addFields(
      { name: "Available balance", value: `${input.balance} Duskits`, inline: true },
      { name: "Lifetime qualifying earned", value: `${input.lifetimeEarned} Duskits`, inline: true },
      { name: "Reversal requests", value: `${input.reversalCount} stored request(s)`, inline: true },
    );
  addEntryFields(embed, input.entries);
  return embed;
}

function buildHistoryEmbed(
  member: AuditMember,
  page: DuskAuditEntryPage,
  pageNumber: number,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Duskits transaction audit")
    .setDescription(`Target member: ${buildMemberLabel(member)}`)
    .setFooter({ text: `History page ${pageNumber}/${MAX_HISTORY_PAGES}` });
  addEntryFields(embed, page.entries);
  return embed;
}

function buildReversalValue(request: DuskAuditReversalRequest): string {
  const resolution = request.resolution;
  return truncate(
    [
      `Status: ${resolution ? resolution.resolutionType : "PENDING"}`,
      `Requested: ${formatAmount(request.requestedAmount)} · Created: ${formatTimestamp(request.createdAt)}`,
      `Reason: ${sanitize(request.reason, 180)}`,
      `Requesting actor: ${sanitize(request.actorDiscordUserId, 80)}`,
      `Original: ${sanitize(request.originalEntryId, 80)} · Amount: ${formatAmount(request.originalEntry.amount)} · ${formatTimestamp(request.originalEntry.createdAt)}`,
      `Original reason: ${sanitize(request.originalEntry.reason, 150)} · Source: ${sanitize(request.sourceEventType, 64)}:${sanitize(request.sourceEventId, 120)}`,
      resolution
        ? `Reviewing actor: ${sanitize(resolution.actorDiscordUserId, 80)} · Reviewed: ${formatTimestamp(resolution.createdAt)} · Review reason: ${sanitize(resolution.reason, 150)}`
        : "Reviewing actor: — · Reviewed: —",
      `Resolution entry: ${sanitize(resolution?.resolutionEntryId, 80)}`,
    ].join("\n"),
    1024,
  );
}

function buildReversalEmbed(
  member: AuditMember,
  requests: DuskAuditReversalRequest[],
  pageNumber: number,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Duskits reversal review audit")
    .setDescription(
      `Target member: ${buildMemberLabel(member)}\nRead-only inspection; no request or resolution state was changed.`,
    )
    .setFooter({ text: `Reversal page ${pageNumber}/${MAX_REVERSAL_PAGES}` });
  if (requests.length === 0) {
    embed.addFields({ name: "Reversal requests", value: "No reversal requests recorded." });
    return embed;
  }
  requests.forEach((request, index) => {
    embed.addFields({
      name: `${index + 1}. ${sanitize(request.id, 100)}`,
      value: buildReversalValue(request),
      inline: false,
    });
  });
  return embed;
}

function buildSourceEmbed(member: AuditMember, detail: DuskSourceEventAudit): EmbedBuilder {
  const sourceEvent = detail.sourceEvent;
  const claimStatus = detail.claimRecordedForEntry ? "RECORDED" : "MISSING / UNVERIFIED";
  const operational = detail.operationalEvidence;
  const claims = detail.claims.length > 0
    ? detail.claims
        .slice(0, 8)
        .map(
          (claim) =>
            `${sanitize(claim.id, 80)} · wallet: ${claim.walletId === detail.entry.walletId ? "target member" : "other wallet (not displayed)"} · entry: ${sanitize(claim.ledgerEntryId, 80)} · beneficiary: ${sanitize(claim.beneficiaryKey, 100)} · ${formatTimestamp(claim.createdAt)}`,
        )
        .join("\n")
    : "No source-event claims are available.";
  const embed = new EmbedBuilder()
    .setTitle("Duskits source-event audit")
    .setDescription(`Target member: ${buildMemberLabel(member)}`)
    .addFields(
      {
        name: "Ledger source reference",
        value: `${sanitize(detail.entry.sourceEventType, 64)}:${sanitize(detail.entry.sourceEventId, 120)}\nThis reference alone is not proof.`,
      },
      {
        name: "Canonical source event",
        value: sourceEvent
          ? `ID: ${sanitize(sourceEvent.id, 100)}\nType: ${sanitize(sourceEvent.sourceEventType, 64)}\nEvent ID: ${sanitize(sourceEvent.sourceEventId, 120)}\nCreated: ${formatTimestamp(sourceEvent.createdAt)}`
          : "UNKNOWN — no canonical source-event row is available.",
      },
      {
        name: "Source-event claims",
        value: `${claimStatus}\n${truncate(claims, 1024)}${detail.claims.length > 8 ? `\n…and ${detail.claims.length - 8} more bounded claims.` : ""}`,
      },
      {
        name: "Operational evidence",
        value: `${operational.status}\nOwner: ${sanitize(operational.owner, 100)}\n${sanitize(operational.summary, 500)}\nRecord: ${safeJson(operational.record)}`,
      },
      {
        name: "Policy provenance",
        value: detail.policy
          ? `Version: ${sanitize(detail.policy.version, 80)}\nKey: ${sanitize(detail.policy.policyKey, 80)}\nDefinition: ${safeJson(detail.policy.definition)}`
          : "UNKNOWN — no stored policy version row is available.",
      },
      {
        name: "Ledger attribution metadata",
        value: safeJson(detail.entry.attribution),
      },
    );
  return embed;
}

function buildWalletRow(prefix: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:history`)
      .setLabel("Transaction history")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${prefix}:reversals`)
      .setLabel("Reversal review")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildHistoryControls(
  prefix: string,
  pageNumber: number,
  page: DuskAuditEntryPage,
): Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:newer`)
      .setLabel("Newer")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageNumber <= 1),
    new ButtonBuilder()
      .setCustomId(`${prefix}:older`)
      .setLabel("Older")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!page.hasMore || pageNumber >= MAX_HISTORY_PAGES),
    new ButtonBuilder()
      .setCustomId(`${prefix}:wallet`)
      .setLabel("Wallet")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${prefix}:reversals`)
      .setLabel("Reversals")
      .setStyle(ButtonStyle.Secondary),
  );
  const rows: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [row];
  if (page.entries.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${prefix}:source`)
      .setPlaceholder("Inspect source-event detail")
      .addOptions(
        page.entries.map((entry) => ({
          label: truncate(`${transactionLabel(entry.transactionType)} ${formatAmount(entry.amount)}`, 100),
          description: truncate(`${entry.id} · ${entry.sourceEventType}`, 100),
          value: entry.id,
        })),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }
  return rows;
}

function buildReversalControls(
  prefix: string,
  pageNumber: number,
  pageCount: number,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:reversal-newer`)
      .setLabel("Newer")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageNumber <= 1),
    new ButtonBuilder()
      .setCustomId(`${prefix}:reversal-older`)
      .setLabel("Older")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageNumber >= pageCount),
    new ButtonBuilder()
      .setCustomId(`${prefix}:wallet`)
      .setLabel("Wallet")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${prefix}:history`)
      .setLabel("History")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildSourceControls(prefix: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:history`)
      .setLabel("Back to history")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${prefix}:wallet`)
      .setLabel("Wallet")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${prefix}:reversals`)
      .setLabel("Reversals")
      .setStyle(ButtonStyle.Secondary),
  );
}

function isAuthorizedDuskAdminInteraction(
  interaction: AdminInteractionEvidence,
  invokingAdminId: string,
  userId: string,
  guildId: string,
): boolean {
  try {
    return (
      userId === invokingAdminId &&
      interaction.guildId === guildId &&
      Boolean(interaction.inGuild?.()) &&
      Boolean(interaction.guild) &&
      Boolean(interaction.member) &&
      Boolean(interaction.memberPermissions) &&
      Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
    );
  } catch {
    return false;
  }
}

export function hasDuskAdministratorPermission(
  interaction: AdminInteractionEvidence,
): boolean {
  try {
    return (
      Boolean(interaction.inGuild?.()) &&
      Boolean(interaction.guildId) &&
      Boolean(interaction.guild) &&
      Boolean(interaction.member) &&
      Boolean(interaction.memberPermissions) &&
      Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
    );
  } catch {
    return false;
  }
}

function makeMember(target: { id: string; displayName?: string; user?: { username?: string } }): AuditMember {
  return {
    id: target.id,
    displayName: target.displayName || target.user?.username || target.id,
    username: target.user?.username || target.id,
  };
}

export const DuskAdmin: Command = {
  name: "dusk-admin",
  description: "Administrator-only read-only Duskits wallet audit",
  suppressVisibilityOption: true,
  options: [
    {
      name: "audit",
      description: "Inspect one current guild member's Duskits wallet",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "user",
          description: "Current member to inspect",
          type: ApplicationCommandOptionType.User,
          required: true,
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService,
  ) => {
    if (!hasDuskAdministratorPermission(interaction)) {
      dozzleLog.warn(
        `[dusk-admin] denied guild=${interaction.guildId ?? "unknown"} reason=administrator_evidence_unavailable_or_missing`,
      );
      await interaction.reply({
        content: "This audit requires the Discord Administrator permission in a guild.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        content: "This audit requires a current guild context.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    let targetMember;
    try {
      const targetUser = interaction.options.getUser("user", true);
      targetMember = await guild.members.fetch(targetUser.id);
    } catch {
      dozzleLog.warn(
        `[dusk-admin] target_membership_unverified guild=${interaction.guildId ?? "unknown"}`,
      );
      await interaction.reply({
        content: "I could not verify that target as a current member of this guild.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (!targetMember) {
      await interaction.reply({
        content: "I could not verify that target as a current member of this guild.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const target = makeMember(targetMember);
    const guildId = interaction.guildId!;
    const invokingAdminId = interaction.user.id;
    const prefix = `dusk-admin:${interaction.id}`;

    await interaction.deferReply({ ephemeral: true });

    try {
      const [balance, lifetimeEarned, recentPage, reversalRequests] = await Promise.all([
        duskLedgerService.getBalance(target.id),
        duskLedgerService.getLifetimeEarned(target.id),
        duskLedgerService.listAuditEntryPage(target.id, null, RECENT_ENTRY_LIMIT),
        duskLedgerService.listReversalRequests(target.id, 50),
      ]);

      let historyPages: DuskAuditEntryPage[] = [];
      let reversalPageNumber = 1;
      let view: "wallet" | "history" | "source" | "reversals" = "wallet";

      const renderWallet = async (component?: ButtonInteraction): Promise<void> => {
        view = "wallet";
        const payload = {
          embeds: [
            buildWalletEmbed({
              member: target,
              balance,
              lifetimeEarned,
              entries: recentPage.entries,
              reversalCount: reversalRequests.length,
            }),
          ],
          components: [buildWalletRow(prefix)],
          allowedMentions: { parse: [] as never[] },
        };
        if (component) await component.update(payload);
        else await interaction.editReply(payload);
      };

      const renderHistory = async (component?: ButtonInteraction): Promise<void> => {
        view = "history";
        if (historyPages.length === 0) {
          historyPages.push(await duskLedgerService.listAuditEntryPage(target.id, null, AUDIT_PAGE_SIZE));
        }
        const page = historyPages.at(-1)!;
        const payload = {
          embeds: [buildHistoryEmbed(target, page, historyPages.length)],
          components: buildHistoryControls(prefix, historyPages.length, page),
          allowedMentions: { parse: [] as never[] },
        };
        if (component) await component.update(payload);
        else await interaction.editReply(payload);
      };

      const renderReversals = async (component?: ButtonInteraction): Promise<void> => {
        view = "reversals";
        const pageCount = Math.max(1, Math.min(MAX_REVERSAL_PAGES, Math.ceil(reversalRequests.length / REVERSAL_PAGE_SIZE)));
        reversalPageNumber = Math.max(1, Math.min(reversalPageNumber, pageCount));
        const start = (reversalPageNumber - 1) * REVERSAL_PAGE_SIZE;
        const payload = {
          embeds: [buildReversalEmbed(target, reversalRequests.slice(start, start + REVERSAL_PAGE_SIZE), reversalPageNumber)],
          components: [buildReversalControls(prefix, reversalPageNumber, pageCount)],
          allowedMentions: { parse: [] as never[] },
        };
        if (component) await component.update(payload);
        else await interaction.editReply(payload);
      };

      const renderSource = async (component: StringSelectMenuInteraction): Promise<void> => {
        const entryId = component.values[0];
        if (!entryId) return;
        const detail = await duskLedgerService.getSourceEventAudit(target.id, entryId, guildId);
        if (!detail) {
          await component.reply({
            content: "That transaction's source detail is unavailable.",
            ephemeral: true,
            allowedMentions: { parse: [] },
          });
          return;
        }
        view = "source";
        await component.update({
          embeds: [buildSourceEmbed(target, detail)],
          components: [buildSourceControls(prefix)],
          allowedMentions: { parse: [] },
        });
      };

      await renderWallet();
      const message = await interaction.fetchReply();
      if (!("createMessageComponentCollector" in message)) return;

      const collector = message.createMessageComponentCollector({
        time: AUDIT_TIMEOUT_MS,
        filter: (component) => component.customId.startsWith(prefix),
      });

      const handleComponent = async (
        component: MessageComponentInteraction,
      ): Promise<void> => {
        try {
          if (!isAuthorizedDuskAdminInteraction(component, invokingAdminId, component.user.id, guildId)) {
            await component.reply({
              content: "This administrator audit session is no longer authorized.",
              ephemeral: true,
              allowedMentions: { parse: [] },
            });
            return;
          }

          if (component.isStringSelectMenu()) {
            await renderSource(component);
            return;
          }
          if (!component.isButton()) return;

          if (component.customId === `${prefix}:history`) {
            await renderHistory(component);
          } else if (component.customId === `${prefix}:reversals`) {
            await renderReversals(component);
          } else if (component.customId === `${prefix}:wallet`) {
            await renderWallet(component);
          } else if (component.customId === `${prefix}:older` && view === "history") {
            const current = historyPages.at(-1);
            if (current?.hasMore && current.nextCursor && historyPages.length < MAX_HISTORY_PAGES) {
              historyPages.push(await duskLedgerService.listAuditEntryPage(target.id, current.nextCursor, AUDIT_PAGE_SIZE));
            }
            await renderHistory(component);
          } else if (component.customId === `${prefix}:newer` && view === "history") {
            if (historyPages.length > 1) historyPages.pop();
            await renderHistory(component);
          } else if (component.customId === `${prefix}:reversal-older` && view === "reversals") {
            reversalPageNumber += 1;
            await renderReversals(component);
          } else if (component.customId === `${prefix}:reversal-newer` && view === "reversals") {
            reversalPageNumber = Math.max(1, reversalPageNumber - 1);
            await renderReversals(component);
          } else {
            return;
          }
        } catch {
          if (!component.replied && !component.deferred) {
            await component.reply({
              content: "Duskits audit data is temporarily unavailable. Please try again later.",
              ephemeral: true,
              allowedMentions: { parse: [] },
            });
          }
        }
      };

      collector.on("collect", handleComponent);
      const end = async (): Promise<void> => {
        await interaction.editReply({ components: [] }).catch(() => undefined);
      };
      collector.on("end", end);
    } catch {
      await interaction.editReply({
        content: "Duskits audit data is temporarily unavailable. Please try again later.",
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      });
    }
  },
};
