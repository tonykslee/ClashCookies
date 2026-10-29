import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { dozzleLog } from "../../helper/dozzleLogger";
import {
  FWA_LAYOUT_TYPES,
  FwaCanonicalLayout,
  FwaLayoutService,
  normalizeLayoutType,
  fwaLayoutService,
} from "../../services/FwaLayoutService";
import { formatFwaLayoutTitle } from "../../services/FwaLayoutTitle";
import {
  LayoutPostChannel,
  LayoutPostMessageResolver,
  LayoutPostPublicationService,
  ResolvedLayoutPostMessage,
  createDiscordLayoutPostResolver,
  layoutPostPublicationService,
} from "../../services/LayoutPostPublicationService";
import { LayoutService, layoutService } from "../../services/LayoutService";

export const FWA_LAYOUT_RETITLE_SUBCOMMAND = {
  name: "layout-retitle",
  description: "Synchronize canonical FWA layout post titles",
  type: ApplicationCommandOptionType.Subcommand,
  options: [
    {
      name: "type",
      description: "Optional FWA layout type; omit to process all types",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: FWA_LAYOUT_TYPES.map((type) => ({ name: type, value: type })),
    },
  ],
} as const;

type RetitleOutcome = { townhall: number; type: string; reason: string };
type RetitleMessage = ResolvedLayoutPostMessage & {
  embeds?: Array<{ title?: string | null } | null>;
};

export type FwaLayoutRetitleCommandDeps = {
  layoutService?: Pick<FwaLayoutService, "listCanonical">;
  presentationService?: Pick<LayoutService, "updatePresentation">;
  publicationService?: Pick<LayoutPostPublicationService, "publish">;
  messageResolver?: LayoutPostMessageResolver;
};

/** Purpose: repair canonical FWA titles in place without changing layout ownership or freshness. */
export async function runFwaLayoutRetitleCommand(
  interaction: ChatInputCommandInteraction,
  deps: FwaLayoutRetitleCommandDeps = {},
): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await replyPrivate(interaction, "Only administrators can retitle FWA layouts.");
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await editPrivate(interaction, "FWA layout retitling requires a guild channel.");
    return;
  }

  const typeInput = interaction.options.getString("type", false);
  const type = typeInput ? normalizeLayoutType(typeInput) : null;
  const layoutServiceForCommand = deps.layoutService ?? fwaLayoutService;
  const presentationService = deps.presentationService ?? layoutService;
  const publicationService = deps.publicationService ?? layoutPostPublicationService;
  const resolver =
    deps.messageResolver ??
    createDiscordLayoutPostResolver(interaction.client, { requireEditable: false });
  const botUserId = interaction.client.user?.id ?? "";
  const summary = {
    updated: 0,
    skipped: 0,
    failed: 0,
    skippedItems: [] as RetitleOutcome[],
    failedItems: [] as RetitleOutcome[],
  };

  try {
    const rows = await layoutServiceForCommand.listCanonical({ type });
    for (const row of rows) {
      if (row.layoutRecord) continue;
      addSkipped(summary, row, "unpublished");
      logRetitle("skipped", row, row.layoutId ?? `TH${row.Townhall}`, "unpublished");
    }
    const groups = groupRetitleRows(rows);

    for (const group of groups) {
      const expectedTitles = new Set(
        group.rows.map((row) => formatFwaLayoutTitle(row.Type, row.Townhall)),
      );
      if (expectedTitles.size > 1) {
        for (const row of group.rows) {
          addSkipped(summary, row, "title_conflict");
          logRetitle("skipped", row, group.record.id, "title_conflict");
        }
        continue;
      }

      const desiredTitle = [...expectedTitles][0];
      const firstRow = group.rows[0];
      if (!firstRow || !desiredTitle) continue;
      const provenance = getCompleteProvenance(group.record);
      if (!provenance) {
        for (const row of group.rows) {
          addSkipped(summary, row, "unpublished");
          logRetitle("skipped", row, group.record.id, "unpublished");
        }
        continue;
      }
      if (provenance.guildId !== guildId) {
        for (const row of group.rows) {
          addSkipped(summary, row, "source_guild_mismatch");
          logRetitle("skipped", row, group.record.id, "source_guild_mismatch", provenance.messageId);
        }
        continue;
      }

      const sourceMessage = await resolveSourceMessage(resolver, provenance);
      if (!sourceMessage) {
        for (const row of group.rows) {
          addSkipped(summary, row, "source_inaccessible");
          logRetitle("skipped", row, group.record.id, "source_inaccessible");
        }
        continue;
      }
      if (!botUserId || sourceMessage.author?.id !== botUserId) {
        for (const row of group.rows) {
          addSkipped(summary, row, "not_bot_authored");
          logRetitle("skipped", row, group.record.id, "not_bot_authored");
        }
        continue;
      }
      if (sourceMessage.editable === false) {
        for (const row of group.rows) {
          addSkipped(summary, row, "not_editable");
          logRetitle("skipped", row, group.record.id, "not_editable");
        }
        continue;
      }

      const currentMessageTitle = getMessageTitle(sourceMessage);
      if (group.record.title?.trim() === desiredTitle && currentMessageTitle === desiredTitle) {
        for (const row of group.rows) {
          addSkipped(summary, row, "already_standard");
          logRetitle("skipped", row, group.record.id, "already_standard");
        }
        continue;
      }

      logRetitle("attempt", firstRow, group.record.id, "none", provenance.messageId);
      try {
        const persisted = group.record.title?.trim() === desiredTitle
          ? group.record
          : await presentationService.updatePresentation(group.record.id, { title: desiredTitle });
        await publicationService.publish({
          layout: persisted,
          guildId,
          channel: buildExistingPostChannel(provenance.channelId),
          messageResolver: resolver,
        });
        summary.updated += group.rows.length;
        for (const row of group.rows) {
          logRetitle("succeeded", row, group.record.id, "none", provenance.messageId);
        }
      } catch (error) {
        const reason = classifyRetitleError(error);
        for (const row of group.rows) {
          addFailed(summary, row, reason);
          logRetitle("failed", row, group.record.id, reason, provenance.messageId);
        }
      }
    }

    await editPrivate(interaction, formatRetitleSummary(summary, type));
  } catch (error) {
    dozzleLog.error(
      `[layout-retitle] event=command_failed guild_id=${guildId} reason=${classifyRetitleError(error)}`,
    );
    await editPrivate(
      interaction,
      "Failed to process `/fwa layout-retitle`. No Discord message was created.",
    );
  }
}

type RetitleGroup = {
  record: NonNullable<FwaCanonicalLayout["layoutRecord"]>;
  rows: FwaCanonicalLayout[];
};

function groupRetitleRows(rows: readonly FwaCanonicalLayout[]): RetitleGroup[] {
  const groups = new Map<string, RetitleGroup>();
  for (const row of rows) {
    const record = row.layoutRecord;
    if (!record) {
      continue;
    }
    const existing = groups.get(record.id);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(record.id, { record, rows: [row] });
    }
  }
  return [...groups.values()];
}

async function resolveSourceMessage(
  resolver: LayoutPostMessageResolver,
  provenance: { guildId: string; channelId: string; messageId: string },
): Promise<RetitleMessage | null> {
  try {
    const message = await resolver.resolve(provenance);
    if (!message || message.id !== provenance.messageId || typeof message.edit !== "function") {
      return null;
    }
    return message as RetitleMessage;
  } catch {
    return null;
  }
}

function buildExistingPostChannel(channelId: string): LayoutPostChannel {
  return {
    id: channelId,
    send: async () => {
      throw new Error("Retitling an existing canonical post must not create a message.");
    },
  };
}

function getCompleteProvenance(record: NonNullable<FwaCanonicalLayout["layoutRecord"]>) {
  if (!record.discordGuildId || !record.discordChannelId || !record.discordMessageId) return null;
  return {
    guildId: record.discordGuildId,
    channelId: record.discordChannelId,
    messageId: record.discordMessageId,
  };
}

function getMessageTitle(message: RetitleMessage): string | null {
  const title = message.embeds?.[0]?.title;
  return typeof title === "string" ? title.trim() : null;
}

function addSkipped(
  summary: { skipped: number; skippedItems: RetitleOutcome[] },
  row: FwaCanonicalLayout,
  reason: string,
): void {
  summary.skipped += 1;
  summary.skippedItems.push({ townhall: row.Townhall, type: row.Type, reason });
}

function addFailed(
  summary: { failed: number; failedItems: RetitleOutcome[] },
  row: FwaCanonicalLayout,
  reason: string,
): void {
  summary.failed += 1;
  summary.failedItems.push({ townhall: row.Townhall, type: row.Type, reason });
}

function formatRetitleSummary(
  summary: {
    updated: number;
    skipped: number;
    failed: number;
    skippedItems: RetitleOutcome[];
    failedItems: RetitleOutcome[];
  },
  type: ReturnType<typeof normalizeLayoutType> | null,
): string {
  const lines = [
    `FWA layout titles${type ? ` (${type})` : ""}: Updated ${summary.updated} · Skipped ${summary.skipped} · Failed ${summary.failed}`,
  ];
  const hasBothOutcomeTypes = summary.skippedItems.length > 0 && summary.failedItems.length > 0;
  const outcomeBudget = hasBothOutcomeTypes ? 900 : 1800;
  appendOutcomeLines(lines, "Skipped", summary.skippedItems, outcomeBudget);
  appendOutcomeLines(lines, "Failed", summary.failedItems, outcomeBudget);
  return lines.join("\n").slice(0, 1900);
}

function appendOutcomeLines(
  lines: string[],
  label: string,
  outcomes: readonly RetitleOutcome[],
  budget: number,
): void {
  if (!outcomes.length) return;
  const prefix = `${label}: `;
  let details = "";
  let included = 0;
  for (const item of outcomes) {
    const token = `TH${item.townhall} ${item.type} (${item.reason})`;
    const next = details ? `${details}, ${token}` : token;
    if (prefix.length + next.length > budget) break;
    details = next;
    included += 1;
  }
  const omitted = outcomes.length - included;
  lines.push(`${prefix}${details || "details omitted"}${omitted ? `, +${omitted} more` : ""}`);
}

function classifyRetitleError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("permission")) return "permission_denied";
  if (message.includes("resolve") || message.includes("access") || message.includes("canonical")) {
    return "source_inaccessible";
  }
  if (message.includes("title") || message.includes("presentation")) return "presentation_write_failed";
  return "discord_edit_failed";
}

function logRetitle(
  event: "attempt" | "succeeded" | "skipped" | "failed",
  row: FwaCanonicalLayout,
  layoutId: string,
  reason: string,
  messageId?: string,
): void {
  dozzleLog[event === "failed" ? "warn" : "info"](
    `[layout-retitle] event=${event} layout_id=${layoutId} townhall=${row.Townhall} type=${row.Type} message_id=${messageId ?? "none"} reason=${reason}`,
  );
}

async function replyPrivate(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
}

async function editPrivate(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
}

export const formatFwaLayoutRetitleSummaryForTest = formatRetitleSummary;
