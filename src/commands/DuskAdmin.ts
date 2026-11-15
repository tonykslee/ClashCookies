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
import { DuskLedgerTransactionType, DuskReversalResolutionType } from "@prisma/client";
import { Command } from "../Command";
import { CoCService } from "../services/CoCService";
import {
  DuskAuditEntryPage,
  DuskAuditLedgerEntry,
  DuskAuditReversalRequest,
  DuskLedgerAmbiguousOutcomeError,
  DuskInsufficientBalanceError,
  DuskLedgerAlreadyReversedError,
  DuskLedgerIdempotencyConflictError,
  DuskLedgerReversalPendingError,
  DuskLedgerValidationError,
  DuskLedgerMutationReference,
  DuskLedgerMutationResult,
  DuskPendingReversalResolutionResult,
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
const MUTATION_TIMEOUT_MS = 5 * 60 * 1000;
const DUSK_WALLET_MUTATION_FLAG = "DUSK_WALLET_MUTATIONS_ENABLED";
const PRODUCTION_ENVIRONMENT_VALUES = new Set(["prod", "production", "live"]);
const OPTIONAL_RUNTIME_ENVIRONMENT_KEYS = ["DEPLOY_ENV", "APP_ENV", "ENVIRONMENT", "NODE_ENV"] as const;

type AdminInteractionEvidence = {
  inGuild?: () => boolean;
  guildId?: string | null;
  guild?: unknown | null;
  member?: unknown | null;
  memberPermissions?: { has: (permission: bigint) => boolean } | null;
};

const DISCORD_EMBED_FIELD_LIMIT = 1024;
const DISCORD_EMBED_TOTAL_LIMIT = 6000;

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

type AuditEmbedField = {
  name: string;
  value: string;
  inline?: boolean;
};

function embedTextLength(embed: EmbedBuilder): number {
  const data = embed.toJSON();
  return [
    data.title,
    data.description,
    data.footer?.text,
    data.author?.name,
    ...(data.fields ?? []).flatMap((field) => [field.name, field.value]),
  ].reduce((total, value) => total + (value?.length ?? 0), 0);
}

function allocateFieldValueBudgets(desiredLengths: number[], available: number): number[] {
  if (desiredLengths.length === 0) return [];
  if (desiredLengths.reduce((total, length) => total + length, 0) <= available) {
    return desiredLengths;
  }

  const minimumBudget = desiredLengths.length;
  const usable = Math.max(minimumBudget, available);
  const fairBudget = Math.floor(usable / desiredLengths.length);
  const remainder = usable % desiredLengths.length;
  const budgets = desiredLengths.map((desiredLength, index) =>
    Math.min(desiredLength, fairBudget + (index < remainder ? 1 : 0)),
  );
  let unallocated = usable - budgets.reduce((total, length) => total + length, 0);
  for (let index = 0; unallocated > 0 && index < budgets.length; index += 1) {
    const extra = Math.min(unallocated, desiredLengths[index] - budgets[index]);
    budgets[index] += extra;
    unallocated -= extra;
  }
  return budgets;
}

function addBudgetedFields(embed: EmbedBuilder, fields: AuditEmbedField[]): void {
  const normalizedFields = fields.map((field) => ({
    ...field,
    name: truncate(field.name, 256),
    value: truncate(field.value, DISCORD_EMBED_FIELD_LIMIT),
  }));
  const existingTextLength = embedTextLength(embed);
  const fieldNameLength = normalizedFields.reduce((total, field) => total + field.name.length, 0);
  const availableValueLength = DISCORD_EMBED_TOTAL_LIMIT - existingTextLength - fieldNameLength;
  const budgets = allocateFieldValueBudgets(
    normalizedFields.map((field) => field.value.length),
    availableValueLength,
  );
  embed.addFields(
    normalizedFields.map((field, index) => ({
      ...field,
      value: truncate(field.value, Math.min(DISCORD_EMBED_FIELD_LIMIT, budgets[index])),
    })),
  );
}

function addEntryFields(embed: EmbedBuilder, entries: DuskAuditLedgerEntry[]): void {
  if (entries.length === 0) {
    addBudgetedFields(embed, [{ name: "Transactions", value: "No transactions recorded." }]);
    return;
  }
  addBudgetedFields(
    embed,
    entries.map((entry, index) => ({
      name: `${index + 1}. ${sanitize(entry.id, 100)}`,
      value: formatEntryValue(entry),
      inline: false,
    })),
  );
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
    .setDescription(`Target member: ${buildMemberLabel(input.member)}`);
  addBudgetedFields(embed, [
      { name: "Available balance", value: `${input.balance} Duskits`, inline: true },
      { name: "Lifetime qualifying earned", value: `${input.lifetimeEarned} Duskits`, inline: true },
      {
        name: "Reversal requests",
        value: `Showing ${input.reversalCount} latest request(s); bounded sample capped at 50.`,
        inline: true,
      },
  ]);
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
    addBudgetedFields(embed, [{ name: "Reversal requests", value: "No reversal requests recorded." }]);
    return embed;
  }
  addBudgetedFields(
    embed,
    requests.map((request, index) => ({
      name: `${index + 1}. ${sanitize(request.id, 100)}`,
      value: buildReversalValue(request),
      inline: false,
    })),
  );
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
  const claimsHeader = `${claimStatus}\nSample: ${detail.claims.length} of ${detail.claimsTotal} claim(s)`;
  const claimsOverflow = detail.claimsSampleTruncated
    ? `…and ${Math.max(0, detail.claimsTotal - detail.claims.length)} more claim(s) not shown in this bounded sample.`
    : "";
  const fixedClaimsLength = claimsHeader.length + (claimsOverflow ? claimsOverflow.length + 1 : 0);
  const claimsBodyBudget = Math.max(0, DISCORD_EMBED_FIELD_LIMIT - fixedClaimsLength - 1);
  const claimsValue = [
    claimsHeader,
    truncate(claims, claimsBodyBudget),
    claimsOverflow,
  ]
    .filter(Boolean)
    .join("\n");
  const embed = new EmbedBuilder()
    .setTitle("Duskits source-event audit")
    .setDescription(`Target member: ${buildMemberLabel(member)}`);
  addBudgetedFields(embed, [
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
        value: claimsValue,
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
  ]);
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

type DuskAdminMutationDraft =
  | {
      kind: "adjust";
      targetId: string;
      target: AuditMember;
      amount: number;
      reason: string;
      sourceEventType: string;
      sourceEventId: string;
      idempotencyKey: string;
    }
  | {
      kind: "reverse";
      targetId: string;
      target: AuditMember;
      originalEntryId: string;
      reason: string;
      sourceEventType: string;
      sourceEventId: string;
      idempotencyKey: string;
    }
  | {
      kind: "resolve";
      targetId: string;
      target: AuditMember;
      reversalRequestId: string;
      resolutionType: DuskReversalResolutionType;
      reason: string;
      request: DuskAuditReversalRequest;
    };

function getAdminSubcommand(interaction: ChatInputCommandInteraction): string {
  try {
    return interaction.options.getSubcommand(false) ?? "audit";
  } catch {
    return "audit";
  }
}

export function isDuskMutationRuntimeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const pollingMode = String(env.POLLING_MODE ?? "").trim().toLowerCase();
  const pollingEnvironment = String(env.POLLING_ENV ?? "").trim().toLowerCase();
  if (pollingMode !== "active" || !PRODUCTION_ENVIRONMENT_VALUES.has(pollingEnvironment)) return false;

  for (const key of OPTIONAL_RUNTIME_ENVIRONMENT_KEYS) {
    const configuredValue = String(env[key] ?? "").trim().toLowerCase();
    if (configuredValue && !PRODUCTION_ENVIRONMENT_VALUES.has(configuredValue)) return false;
  }

  return String(env[DUSK_WALLET_MUTATION_FLAG] ?? "").trim().toLowerCase() === "true";
}

function mutationOptionDefinitions() {
  return [
    {
      name: "user",
      description: "Current guild member whose wallet is being corrected",
      type: ApplicationCommandOptionType.User,
      required: true,
    },
    {
      name: "amount",
      description: "Signed Duskits adjustment; negative debits are balance-checked",
      type: ApplicationCommandOptionType.Integer,
      required: true,
      minValue: -2_147_483_647,
      maxValue: 2_147_483_647,
    },
    {
      name: "reason",
      description: "Nonempty technical correction reason",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 500,
    },
    {
      name: "source-type",
      description: "Durable source or case type",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 64,
    },
    {
      name: "source-id",
      description: "Durable source or case identifier",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 128,
    },
    {
      name: "idempotency-key",
      description: "Stable key for safe retries of this exact correction",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 128,
    },
  ];
}

function reverseOptionDefinitions() {
  return [
    {
      name: "user",
      description: "Current guild member whose wallet is being reviewed",
      type: ApplicationCommandOptionType.User,
      required: true,
    },
    {
      name: "transaction",
      description: "Original ledger entry ID to reverse",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 64,
    },
    {
      name: "reason",
      description: "Nonempty technical reversal reason",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 500,
    },
    {
      name: "source-type",
      description: "Durable reversal case type",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 64,
    },
    {
      name: "source-id",
      description: "Durable reversal case identifier",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 128,
    },
    {
      name: "idempotency-key",
      description: "Stable key for safe retries of this exact reversal",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 128,
    },
  ];
}

function resolveOptionDefinitions() {
  return [
    {
      name: "user",
      description: "Current guild member who owns the pending review",
      type: ApplicationCommandOptionType.User,
      required: true,
    },
    {
      name: "request",
      description: "Pending reversal request ID",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 64,
    },
    {
      name: "action",
      description: "Apply only if the balance can remain nonnegative, or decline",
      type: ApplicationCommandOptionType.String,
      required: true,
      choices: [
        { name: "Apply reversal", value: "apply" },
        { name: "Decline reversal", value: "decline" },
      ],
    },
    {
      name: "reason",
      description: "Nonempty review resolution reason",
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: 500,
    },
  ];
}

function buildMutationPreview(draft: DuskAdminMutationDraft): string {
  if (draft.kind === "adjust") {
    return [
      "**Confirm technical Duskits adjustment**",
      `Target: ${buildMemberLabel(draft.target)}`,
      `Signed amount: ${formatAmount(draft.amount)} Duskits`,
      `Reason: ${sanitize(draft.reason, 300)}`,
      `Source: ${sanitize(draft.sourceEventType, 64)}:${sanitize(draft.sourceEventId, 128)}`,
      `Idempotency key: ${sanitize(draft.idempotencyKey, 128)}`,
      "This appends one immutable correction entry. It is not a routine reward or a voluntary refund.",
    ].join("\n");
  }
  if (draft.kind === "reverse") {
    return [
      "**Confirm technical Duskits reversal**",
      `Target: ${buildMemberLabel(draft.target)}`,
      `Original transaction: ${sanitize(draft.originalEntryId, 80)}`,
      `Reason: ${sanitize(draft.reason, 300)}`,
      `Source: ${sanitize(draft.sourceEventType, 64)}:${sanitize(draft.sourceEventId, 128)}`,
      `Idempotency key: ${sanitize(draft.idempotencyKey, 128)}`,
      "If the wallet cannot absorb the reversal, this creates an auditable pending review instead of a negative balance.",
    ].join("\n");
  }
  return [
    `**Confirm pending reversal ${draft.resolutionType === DuskReversalResolutionType.APPLIED ? "application" : "decline"}**`,
    `Target: ${buildMemberLabel(draft.target)}`,
    `Request: ${sanitize(draft.reversalRequestId, 80)}`,
    `Requested amount: ${formatAmount(draft.request.requestedAmount)} Duskits`,
    `Original transaction: ${sanitize(draft.request.originalEntryId, 80)}`,
    `Review reason: ${sanitize(draft.reason, 300)}`,
    `Original request key: ${sanitize(draft.request.idempotencyKey, 128)}`,
    draft.resolutionType === DuskReversalResolutionType.APPLIED
      ? "Apply appends the compensating entry only if the wallet remains nonnegative."
      : "Decline records an immutable resolution without changing the wallet.",
  ].join("\n");
}

function buildMutationControls(prefix: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:confirm`)
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${prefix}:cancel`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildMutationReference(draft: DuskAdminMutationDraft): DuskLedgerMutationReference {
  if (draft.kind === "adjust") {
    return {
      operation: "correction",
      idempotencyKey: draft.idempotencyKey,
      sourceEventType: draft.sourceEventType,
      sourceEventId: draft.sourceEventId,
    };
  }
  if (draft.kind === "reverse") {
    return {
      operation: "reversal",
      idempotencyKey: draft.idempotencyKey,
      sourceEventType: draft.sourceEventType,
      sourceEventId: draft.sourceEventId,
      originalEntryId: draft.originalEntryId,
    };
  }
  return {
    operation: "pending-reversal-resolution",
    idempotencyKey: draft.request.idempotencyKey,
    sourceEventType: draft.request.sourceEventType,
    sourceEventId: draft.request.sourceEventId,
    originalEntryId: draft.request.originalEntryId,
    reversalRequestId: draft.reversalRequestId,
  };
}

function mergeMutationReferences(
  preferred: DuskLedgerMutationReference | undefined,
  fallback: DuskLedgerMutationReference,
): DuskLedgerMutationReference {
  return {
    operation: preferred?.operation ?? fallback.operation,
    ledgerEntryId: preferred?.ledgerEntryId ?? fallback.ledgerEntryId,
    idempotencyKey: preferred?.idempotencyKey ?? fallback.idempotencyKey,
    sourceEventType: preferred?.sourceEventType ?? fallback.sourceEventType,
    sourceEventId: preferred?.sourceEventId ?? fallback.sourceEventId,
    originalEntryId: preferred?.originalEntryId ?? fallback.originalEntryId,
    reversalRequestId: preferred?.reversalRequestId ?? fallback.reversalRequestId,
  };
}

function formatMutationReference(reference: DuskLedgerMutationReference): string {
  const values = [
    reference.reversalRequestId ? `request=${sanitize(reference.reversalRequestId, 80)}` : null,
    reference.ledgerEntryId ? `ledger-entry=${sanitize(reference.ledgerEntryId, 80)}` : null,
    reference.originalEntryId ? `transaction=${sanitize(reference.originalEntryId, 80)}` : null,
    reference.sourceEventType && reference.sourceEventId
      ? `source=${sanitize(reference.sourceEventType, 64)}:${sanitize(reference.sourceEventId, 128)}`
      : null,
    reference.idempotencyKey ? `idempotency=${sanitize(reference.idempotencyKey, 128)}` : null,
  ].filter((value): value is string => Boolean(value));
  return values.join(" · ") || "reference unavailable";
}

function addResultReference(
  result: DuskLedgerMutationResult | DuskPendingReversalResolutionResult,
  reference: DuskLedgerMutationReference,
): DuskLedgerMutationReference {
  const ledgerEntryId = result.outcome === "applied"
    ? result.entry.id
    : result.outcome === "resolved" && result.entry
      ? result.entry.id
      : undefined;
  return ledgerEntryId ? { ...reference, ledgerEntryId } : reference;
}

function formatMutationError(
  error: unknown,
  fallbackReference: DuskLedgerMutationReference = { operation: "correction" },
): string {
  if (error instanceof DuskLedgerAmbiguousOutcomeError) {
    return [
      "**Duskits mutation outcome requires reconciliation**",
      "The database outcome is uncertain; no rollback is assumed. Do not retry with changed provenance.",
      `Reconcile privately using: ${formatMutationReference(mergeMutationReferences(error.reference, fallbackReference))}`,
    ].join("\n");
  }
  if (error instanceof DuskInsufficientBalanceError) {
    return "No wallet change was recorded: this would make the balance negative.";
  }
  if (error instanceof DuskLedgerAlreadyReversedError) {
    return "No wallet change was recorded: that transaction is already reversed.";
  }
  if (error instanceof DuskLedgerReversalPendingError) {
    return "No wallet change was recorded: that transaction already has a pending review.";
  }
  if (error instanceof DuskLedgerIdempotencyConflictError) {
    return "No wallet change was recorded: the idempotency or provenance key conflicts with an existing request.";
  }
  if (error instanceof DuskLedgerValidationError) {
    return `No wallet change was recorded: ${sanitize(error.message, 400)}`;
  }
  return [
    "**Duskits mutation outcome requires reconciliation**",
    "The database outcome could not be confirmed; no rollback is assumed.",
    `Reconcile privately using: ${formatMutationReference(fallbackReference)}`,
  ].join("\n");
}

function formatMutationPreparationError(error: unknown): string {
  if (error instanceof DuskLedgerValidationError) {
    return `Duskits mutation could not be prepared: ${sanitize(error.message, 400)} No ledger operation was attempted.`;
  }
  return "Duskits mutation could not be prepared; no ledger operation was attempted.";
}

function formatMutationResult(
  result: DuskLedgerMutationResult | DuskPendingReversalResolutionResult,
  reference: DuskLedgerMutationReference,
): string {
  if (result.outcome === "pending_review") {
    return [
      "**Pending reversal review recorded**",
      `Request: ${sanitize(result.reversalRequest.id, 80)}`,
      `Requested amount: ${formatAmount(result.reversalRequest.requestedAmount)} Duskits`,
      `Current balance: ${result.balance} Duskits`,
      `Reconcile: ${formatMutationReference(reference)}`,
      "No negative balance or reversal entry was created.",
    ].join("\n");
  }
  if (result.outcome === "resolved") {
    return [
      `**Pending reversal ${result.resolution.resolutionType === DuskReversalResolutionType.APPLIED ? "applied" : "declined"}**`,
      `Resolution: ${sanitize(result.resolution.id, 80)}${result.duplicate ? " (idempotent replay)" : ""}`,
      result.entry ? `Ledger entry: ${sanitize(result.entry.id, 80)} · Amount: ${formatAmount(result.entry.amount)} Duskits` : "Ledger entry: none",
      `Balance: ${result.balance} Duskits`,
      `Reconcile: ${formatMutationReference(reference)}`,
    ].join("\n");
  }
  return [
    `**Duskits ${result.entry.transactionType.toLowerCase()} applied**${result.duplicate ? " (idempotent replay)" : ""}`,
    `Ledger entry: ${sanitize(result.entry.id, 80)} · Amount: ${formatAmount(result.entry.amount)} Duskits`,
    `Balance: ${result.balance} Duskits`,
    `Reconcile: ${formatMutationReference(reference)}`,
  ].join("\n");
}

async function deliverMutationOutcome(
  component: MessageComponentInteraction,
  content: string,
  reference: DuskLedgerMutationReference,
  committed: boolean,
): Promise<void> {
  const payload = {
    content,
    components: [],
    allowedMentions: { parse: [] },
  };
  try {
    await component.update(payload);
    return;
  } catch (error) {
    dozzleLog.error(
      `[dusk-admin] mutation_response_failed committed=${committed ? 1 : 0} references=${sanitize(formatMutationReference(reference), 300)} error=${sanitize(String(error), 200)}`,
    );
  }

  const fallbackContent = committed
    ? [
        "**Duskits mutation completed, but Discord could not update the original confirmation.**",
        "The ledger mutation completed; no rollback is assumed.",
        `Reconcile privately using: ${formatMutationReference(reference)}`,
      ].join("\n")
    : content;
  try {
    await component.followUp({
      content: fallbackContent,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  } catch (fallbackError) {
    dozzleLog.error(
      `[dusk-admin] mutation_response_fallback_failed committed=${committed ? 1 : 0} references=${sanitize(formatMutationReference(reference), 300)} error=${sanitize(String(fallbackError), 200)}`,
    );
  }
}

async function runDuskAdminMutation(
  interaction: ChatInputCommandInteraction,
  subcommand: "adjust" | "reverse" | "resolve",
): Promise<void> {
  if (!hasDuskAdministratorPermission(interaction)) {
    dozzleLog.warn(
      `[dusk-admin] mutation_denied guild=${interaction.guildId ?? "unknown"} reason=administrator_evidence_unavailable_or_missing`,
    );
    await interaction.reply({
      content: "This wallet mutation requires the Discord Administrator permission in a guild.",
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (!isDuskMutationRuntimeAllowed()) {
    dozzleLog.warn(
      `[dusk-admin] mutation_denied guild=${interaction.guildId ?? "unknown"} reason=runtime_not_explicitly_enabled_production`,
    );
    await interaction.reply({
      content: "Duskits wallet mutations are disabled outside the explicitly enabled active production runtime.",
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild || !interaction.guildId) {
    await interaction.reply({
      content: "This wallet mutation requires a current guild context.",
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  let targetUser: { id: string };
  try {
    targetUser = interaction.options.getUser("user", true);
  } catch {
    await interaction.reply({
      content: "A current guild member target is required.",
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  let targetMember: { id: string; displayName?: string; user?: { username?: string } } | null;
  try {
    targetMember = await guild.members.fetch({ user: targetUser.id, force: true });
  } catch {
    targetMember = null;
  }
  if (!targetMember || targetMember.id !== targetUser.id) {
    await interaction.reply({
      content: "I could not verify that target as a current member of this guild.",
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const target = makeMember(targetMember);
  let draft: DuskAdminMutationDraft;
  try {
    if (subcommand === "adjust") {
      draft = {
        kind: "adjust",
        targetId: target.id,
        target,
        amount: interaction.options.getInteger("amount", true),
        reason: interaction.options.getString("reason", true),
        sourceEventType: interaction.options.getString("source-type", true),
        sourceEventId: interaction.options.getString("source-id", true),
        idempotencyKey: interaction.options.getString("idempotency-key", true),
      };
    } else if (subcommand === "reverse") {
      draft = {
        kind: "reverse",
        targetId: target.id,
        target,
        originalEntryId: interaction.options.getString("transaction", true),
        reason: interaction.options.getString("reason", true),
        sourceEventType: interaction.options.getString("source-type", true),
        sourceEventId: interaction.options.getString("source-id", true),
        idempotencyKey: interaction.options.getString("idempotency-key", true),
      };
    } else {
      const reversalRequestId = interaction.options.getString("request", true);
      const action = interaction.options.getString("action", true);
      const request = await duskLedgerService.getReversalRequest(target.id, reversalRequestId);
      if (!request) {
        await interaction.reply({
          content: "That reversal request was not found for the verified target member.",
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (action !== "apply" && action !== "decline") {
        throw new DuskLedgerValidationError("action must be apply or decline.");
      }
      draft = {
        kind: "resolve",
        targetId: target.id,
        target,
        reversalRequestId,
        resolutionType: action === "apply" ? DuskReversalResolutionType.APPLIED : DuskReversalResolutionType.DECLINED,
        reason: interaction.options.getString("reason", true),
        request,
      };
    }
  } catch (error) {
    await interaction.reply({
      content: formatMutationPreparationError(error),
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const prefix = `dusk-admin:mutation:${interaction.id}`;
  await interaction.reply({
    content: buildMutationPreview(draft),
    components: [buildMutationControls(prefix)],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });

  const message = await interaction.fetchReply();
  if (!("createMessageComponentCollector" in message)) return;
  const collector = message.createMessageComponentCollector({
    time: MUTATION_TIMEOUT_MS,
    filter: (component: MessageComponentInteraction) => component.customId.startsWith(prefix),
  });

  collector.on("collect", async (component: MessageComponentInteraction) => {
    let mutationAttempted = false;
    const reference = buildMutationReference(draft);
    try {
      if (!isAuthorizedDuskAdminInteraction(component, interaction.user.id, component.user.id, interaction.guildId!)) {
        await component.reply({
          content: "This wallet mutation session is no longer authorized.",
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (!component.isButton()) return;
      if (component.customId === `${prefix}:cancel`) {
        await component.update({
          content: "Wallet mutation cancelled; no ledger state changed.",
          components: [],
          allowedMentions: { parse: [] },
        });
        collector.stop("cancelled");
        return;
      }
      if (component.customId !== `${prefix}:confirm`) return;

      let currentTarget;
      try {
        currentTarget = await interaction.guild?.members.fetch({ user: draft.targetId, force: true });
      } catch {
        currentTarget = null;
      }
      if (!currentTarget || currentTarget.id !== draft.targetId) {
        await component.update({
          content: "The target is no longer a verified current guild member; no ledger operation was attempted.",
          components: [],
          allowedMentions: { parse: [] },
        });
        collector.stop("target_membership_changed");
        return;
      }

      if (
        !isAuthorizedDuskAdminInteraction(component, interaction.user.id, component.user.id, interaction.guildId!) ||
        !isDuskMutationRuntimeAllowed()
      ) {
        await component.update({
          content: "Wallet mutation authorization is no longer active; no ledger operation was attempted.",
          components: [],
          allowedMentions: { parse: [] },
        });
        collector.stop("authorization_changed");
        return;
      }

      mutationAttempted = true;
      let result: DuskLedgerMutationResult | DuskPendingReversalResolutionResult | undefined;
      let mutationError: unknown;
      try {
        const actorDiscordUserId = interaction.user.id;
        if (draft.kind === "adjust") {
          result = await duskLedgerService.recordCorrection({
            discordUserId: draft.targetId,
            amount: draft.amount,
            sourceEventType: draft.sourceEventType,
            sourceEventId: draft.sourceEventId,
            idempotencyKey: draft.idempotencyKey,
            reason: draft.reason,
            actorDiscordUserId,
            attribution: { guildId: interaction.guildId, command: "dusk-admin adjust" },
          });
        } else if (draft.kind === "reverse") {
          result = await duskLedgerService.reverse({
            discordUserId: draft.targetId,
            originalEntryId: draft.originalEntryId,
            sourceEventType: draft.sourceEventType,
            sourceEventId: draft.sourceEventId,
            idempotencyKey: draft.idempotencyKey,
            reason: draft.reason,
            actorDiscordUserId,
            attribution: { guildId: interaction.guildId, command: "dusk-admin reverse" },
          });
        } else {
          result = await duskLedgerService.resolvePendingReversal({
            discordUserId: draft.targetId,
            reversalRequestId: draft.reversalRequestId,
            resolutionType: draft.resolutionType,
            reason: draft.reason,
            actorDiscordUserId,
          });
        }
      } catch (error) {
        mutationError = error;
      }

      const content = mutationError
        ? formatMutationError(mutationError, reference)
        : formatMutationResult(result!, addResultReference(result!, reference));
      await deliverMutationOutcome(
        component,
        content,
        result ? addResultReference(result, reference) : reference,
        Boolean(result),
      );
      collector.stop("completed");
    } catch (error) {
      if (mutationAttempted) {
        await deliverMutationOutcome(component, formatMutationError(error, reference), reference, false);
        collector.stop("completed");
        return;
      }
      if (!component.replied && !component.deferred) {
        await component.reply({
          content: "Duskits mutation verification failed; no ledger operation was attempted.",
          ephemeral: true,
          allowedMentions: { parse: [] },
        }).catch(() => undefined);
      }
    }
  });

  collector.on("end", async () => {
    await interaction.editReply({ components: [] }).catch(() => undefined);
  });
}

export const DuskAdmin: Command = {
  name: "dusk-admin",
  description: "Administrator-only Duskits wallet audit and technical controls",
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
    {
      name: "adjust",
      description: "Preview and append one signed technical correction",
      type: ApplicationCommandOptionType.Subcommand,
      options: mutationOptionDefinitions(),
    },
    {
      name: "reverse",
      description: "Preview and append one technical reversal",
      type: ApplicationCommandOptionType.Subcommand,
      options: reverseOptionDefinitions(),
    },
    {
      name: "resolve",
      description: "Preview and resolve one pending reversal review",
      type: ApplicationCommandOptionType.Subcommand,
      options: resolveOptionDefinitions(),
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService,
  ) => {
    const subcommand = getAdminSubcommand(interaction);
    if (subcommand === "adjust" || subcommand === "reverse" || subcommand === "resolve") {
      await runDuskAdminMutation(interaction, subcommand);
      return;
    }
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
      targetMember = await guild.members.fetch({ user: targetUser.id, force: true });
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
