import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { buildClanProfileMarkdownLink } from "../helper/clanProfileLink";
import { formatError } from "../helper/formatError";
import {
  isCompoActualStateDeviationHealthy,
  isCompoActualStateProjectionComplete,
  projectCompoActualStateView,
} from "../helper/compoActualStateView";
import { prisma } from "../prisma";
import { normalizeClanTag } from "./PlayerLinkService";
import { FwaClanMembersSyncService } from "./fwa-feeds/FwaClanMembersSyncService";
import {
  loadCompoActualStateContext,
  type CompoActualStateClanContext,
  type CompoActualStateContext,
} from "./CompoActualStateService";
import {
  parseSyncTimeMetadata,
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  trackedMessageService,
  type SyncReadinessTrackedMetadata,
  type SyncTimeTrackedMetadata,
} from "./TrackedMessageService";
import type { HeatMapRef } from "@prisma/client";

const SYNC_READINESS_REFRESH_BUTTON_PREFIX = "sync-time:fwa-clan-list";
export const SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID =
  `${SYNC_READINESS_REFRESH_BUTTON_PREFIX}:refresh`;
const SYNC_READINESS_REFRESH_COOLDOWN_MS = 60 * 1000;
const SYNC_READINESS_REFRESH_LOCK_STALE_MS = 5 * 60 * 1000;

export type SyncReadinessMode = "sync_time" | "standalone";

export type SyncReadinessMessagePayload = {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  metadata: SyncTimeTrackedMetadata | SyncReadinessTrackedMetadata;
  trackedClanCount: number;
};

type ReadinessSourceRefreshSummary = {
  trackedClanCount: number;
  syncAllFailedClanTags: string[];
  currentMemberFailedClanTags: string[];
};

function parseOptionalIsoDate(input: string | null | undefined): Date | null {
  const normalized = String(input ?? "").trim();
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function formatDeviationScore(value: number | null): string {
  if (value === null) return "n/a";
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

function normalizeLabelText(input: unknown): string | null {
  const normalized = String(input ?? "")
    .normalize("NFKC")
    .replace(/["'`]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function buildFallbackClanAbbreviation(clan: {
  clanName: string | null;
  clanTag: string;
}): string {
  const normalized = normalizeLabelText(clan.clanName);
  if (normalized) {
    const parts = normalized.split(" ").filter(Boolean);
    if (parts.length > 1) {
      const initials = parts
        .map((part) => part[0] ?? "")
        .join("")
        .replace(/[^A-Za-z0-9]/g, "")
        .toUpperCase();
      if (initials) {
        return initials.slice(0, 4);
      }
    }

    const compact = normalized.replace(/\s+/g, "").toUpperCase();
    if (compact) {
      return compact.slice(0, 4);
    }
  }

  const normalizedTag = normalizeClanTag(clan.clanTag) ?? clan.clanTag;
  const compactTag = normalizedTag.replace(/^#/, "").toUpperCase();
  return compactTag.slice(0, 4) || "UNK";
}

function buildReadinessLabel(clan: Pick<CompoActualStateClanContext, "shortName" | "clanName" | "clanTag">): string {
  const shortName = String(clan.shortName ?? "").trim();
  if (shortName) {
    return shortName;
  }
  return buildFallbackClanAbbreviation({
    clanName: clan.clanName,
    clanTag: clan.clanTag,
  });
}

function buildRefreshRow(input: {
  state: "default" | "refreshing" | "closed";
}): ActionRowBuilder<ButtonBuilder> {
  const label =
    input.state === "refreshing"
      ? "Refreshing..."
      : input.state === "closed"
        ? "Refresh closed"
        : "Refresh";
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID)
      .setEmoji("🔄")
      .setLabel(label)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(input.state !== "default"),
  );
}

function buildReadinessRow(clan: CompoActualStateClanContext, heatMapRefs: readonly HeatMapRef[]): string {
  const projection = projectCompoActualStateView({
    view: "auto",
    base: clan.base,
    heatMapRefs,
  });
  const deviationScore = projection.deviationScore ?? null;
  const healthy =
    clan.base.memberCount === 50 &&
    isCompoActualStateProjectionComplete(projection) &&
    isCompoActualStateDeviationHealthy(deviationScore);
  const indicator = healthy ? "✅" : "⚠️";
  const label = buildReadinessLabel(clan);
  const link = buildClanProfileMarkdownLink(clan.clanName, clan.clanTag);
  return `${indicator} | ${label} | ${link} | ${clan.base.memberCount}/50 | Dev ${formatDeviationScore(
    deviationScore,
  )}`;
}

function buildReadinessDescription(context: CompoActualStateContext): string {
  if (context.clans.length === 0) {
    return [
      "No tracked clans are configured for DB-backed ACTUAL readiness.",
    ].join("\n");
  }

  return [
    ...context.clans.map((clan) => buildReadinessRow(clan, context.heatMapRefs)),
    "",
    "✅ = 50/50 and within the shared healthy deviation threshold.",
    "⚠️ = under/over 50, incomplete data, unhealthy deviation, or unavailable data.",
  ].join("\n");
}

function buildReadinessEmbed(context: CompoActualStateContext): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`FWA Readiness (${context.clans.length})`)
    .setDescription(buildReadinessDescription(context))
    .setColor(0x57f287);
}

function buildSyncTimeRefreshExpiresAt(baseMetadata: SyncTimeTrackedMetadata): Date | null {
  return parseOptionalIsoDate(baseMetadata.syncTimeIso ?? null);
}

function buildSyncTimeTrackedMetadata(input: {
  baseMetadata: SyncTimeTrackedMetadata;
  now: Date;
  successfulRefreshAt?: Date | null;
  inProgressAt?: Date | null;
  inProgressByUserId?: string | null;
  lockToken?: string | null;
}): SyncTimeTrackedMetadata {
  return {
    ...input.baseMetadata,
    fwaClanListEnabled: true,
    fwaClanListRefreshExpiresAtIso: input.baseMetadata.syncTimeIso,
    fwaClanListLastRefreshedAtIso: input.now.toISOString(),
    ...(input.successfulRefreshAt
      ? {
          fwaClanListLastSuccessfulRefreshAtIso: input.successfulRefreshAt.toISOString(),
        }
      : {}),
    ...(input.inProgressAt
      ? {
          fwaClanListRefreshInProgressAtIso: input.inProgressAt.toISOString(),
          fwaClanListRefreshInProgressByUserId: input.inProgressByUserId ?? null,
        }
      : {}),
    ...(input.lockToken ? { fwaClanListRefreshLockToken: input.lockToken } : {}),
  };
}

function stripRefreshLockMetadata<T extends SyncTimeTrackedMetadata | SyncReadinessTrackedMetadata>(
  metadata: T,
): T {
  if ("syncTimeIso" in metadata) {
    const next = { ...metadata } as SyncTimeTrackedMetadata;
    delete next.fwaClanListRefreshInProgressAtIso;
    delete next.fwaClanListRefreshInProgressByUserId;
    delete next.fwaClanListRefreshLockToken;
    return next as T;
  }
  const next = { ...metadata } as SyncReadinessTrackedMetadata;
  delete next.refreshInProgressAtIso;
  delete next.refreshInProgressByUserId;
  delete next.refreshLockToken;
  return next as T;
}

function buildStandaloneReadinessMetadata(input: {
  baseMetadata: SyncReadinessTrackedMetadata;
  now: Date;
  successfulRefreshAt?: Date | null;
  inProgressAt?: Date | null;
  inProgressByUserId?: string | null;
  lockToken?: string | null;
}): SyncReadinessTrackedMetadata {
  return {
    ...input.baseMetadata,
    readinessEnabled: true,
    lastRefreshedAtIso: input.now.toISOString(),
    ...(input.successfulRefreshAt
      ? {
          lastSuccessfulRefreshAtIso: input.successfulRefreshAt.toISOString(),
        }
      : {}),
    ...(input.inProgressAt
      ? {
          refreshInProgressAtIso: input.inProgressAt.toISOString(),
          refreshInProgressByUserId: input.inProgressByUserId ?? null,
        }
      : {}),
    ...(input.lockToken ? { refreshLockToken: input.lockToken } : {}),
  };
}

function buildSyncReadinessContent(): string {
  return "# FWA readiness";
}

function isReadinessRefreshWindowExpired(
  metadata: SyncTimeTrackedMetadata,
  now: Date,
): boolean {
  const expiresAt = buildSyncTimeRefreshExpiresAt(metadata);
  return !expiresAt || expiresAt.getTime() <= now.getTime();
}

function getCooldownRemainingMs(metadata: {
  fwaClanListLastSuccessfulRefreshAtIso?: string | null;
  lastSuccessfulRefreshAtIso?: string | null;
}, now: Date): number {
  const lastSuccessful = parseOptionalIsoDate(
    metadata.fwaClanListLastSuccessfulRefreshAtIso ?? metadata.lastSuccessfulRefreshAtIso ?? null,
  );
  if (!lastSuccessful) return 0;
  const cooldownUntil = lastSuccessful.getTime() + SYNC_READINESS_REFRESH_COOLDOWN_MS;
  return Math.max(0, cooldownUntil - now.getTime());
}

function parseStandaloneReadinessMetadata(
  value: unknown,
): SyncReadinessTrackedMetadata | null {
  if (value === null || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (data.readinessEnabled !== true) return null;
  const createdAtIso = String(data.createdAtIso ?? "").trim();
  if (!createdAtIso) return null;
  return {
    readinessEnabled: true,
    createdAtIso,
    lastRefreshedAtIso:
      typeof data.lastRefreshedAtIso === "string" ? data.lastRefreshedAtIso : null,
    lastSuccessfulRefreshAtIso:
      typeof data.lastSuccessfulRefreshAtIso === "string"
        ? data.lastSuccessfulRefreshAtIso
        : null,
    refreshInProgressAtIso:
      typeof data.refreshInProgressAtIso === "string"
        ? data.refreshInProgressAtIso
        : null,
    refreshInProgressByUserId:
      typeof data.refreshInProgressByUserId === "string"
        ? data.refreshInProgressByUserId
        : null,
    refreshLockToken:
      typeof data.refreshLockToken === "string" ? data.refreshLockToken : null,
  };
}

export async function refreshTrackedClanReadinessState(input: {
  guildId: string;
}): Promise<ReadinessSourceRefreshSummary> {
  const context = await loadCompoActualStateContext(input.guildId);
  const trackedClanTags = context.trackedClanTags;
  if (trackedClanTags.length === 0) {
    return {
      trackedClanCount: 0,
      syncAllFailedClanTags: [],
      currentMemberFailedClanTags: [],
    };
  }

  const clanMembersSync = new FwaClanMembersSyncService();
  // FWAStats sync refreshes the persisted member weights/catalog used by ACTUAL projection.
  // Live CoC member refresh refreshes the canonical current-member rows and town hall data.
  // Both feeds are required for the readiness dashboard, so we keep both passes here.
  const syncAll = await clanMembersSync.syncAllTrackedClans({ force: true });
  const currentMembers = await clanMembersSync.refreshCurrentClanMembersForClanTags(
    trackedClanTags,
  );

  return {
    trackedClanCount: trackedClanTags.length,
    syncAllFailedClanTags: syncAll.failedClans,
    currentMemberFailedClanTags: currentMembers.failedClans,
  };
}

async function renderReadinessPayload(input: {
  guildId?: string | null;
  mode: SyncReadinessMode;
  now?: Date;
  baseMetadata: SyncTimeTrackedMetadata | SyncReadinessTrackedMetadata;
  includeRefreshButton?: boolean;
}): Promise<SyncReadinessMessagePayload> {
  const now = input.now ?? new Date();
  const context = await loadCompoActualStateContext(input.guildId ?? null);
  const embed = buildReadinessEmbed(context);
  const trackedClanCount = context.clans.length;

  console.info(
    `[sync-time-fwa-list] rendered mode=${input.mode} guild_id=${String(
      input.guildId ?? "",
    ).trim() || "unknown"} tracked_clan_count=${trackedClanCount}`,
  );

  return {
    content:
      input.mode === "sync_time"
        ? buildSyncTimeMessageContent(
            (input.baseMetadata as SyncTimeTrackedMetadata).syncEpochSeconds,
            (input.baseMetadata as SyncTimeTrackedMetadata).roleId,
          )
        : buildSyncReadinessContent(),
    embeds: [embed],
    components:
      input.includeRefreshButton === false
        ? []
        : [
            buildRefreshRow({
              state:
                input.mode === "sync_time" &&
                isReadinessRefreshWindowExpired(input.baseMetadata as SyncTimeTrackedMetadata, now)
                  ? "closed"
                  : "default",
            }),
          ],
    metadata:
      input.mode === "sync_time"
        ? buildSyncTimeTrackedMetadata({
            baseMetadata: stripRefreshLockMetadata(
              input.baseMetadata as SyncTimeTrackedMetadata,
            ),
            now,
          })
        : buildStandaloneReadinessMetadata({
            baseMetadata: stripRefreshLockMetadata(
              input.baseMetadata as SyncReadinessTrackedMetadata,
            ),
            now,
          }),
    trackedClanCount,
  };
}

export async function tryClaimRefreshLock(input: {
  trackedMessageId: string;
  updatedAt: Date;
  now: Date;
  userId: string;
  metadata: SyncTimeTrackedMetadata | SyncReadinessTrackedMetadata;
}): Promise<{ claimed: boolean; lockToken: string }> {
  const lockToken = randomUUID();
  const inProgressAtIso =
    "syncTimeIso" in input.metadata
      ? input.metadata.fwaClanListRefreshInProgressAtIso
      : input.metadata.refreshInProgressAtIso;
  if (inProgressAtIso) {
    const inProgressAt = parseOptionalIsoDate(inProgressAtIso);
    if (
      inProgressAt &&
      input.now.getTime() - inProgressAt.getTime() < SYNC_READINESS_REFRESH_LOCK_STALE_MS
    ) {
      return { claimed: false, lockToken };
    }
  }
  const result = await prisma.trackedMessage.updateMany({
    where: {
      messageId: input.trackedMessageId,
      updatedAt: input.updatedAt,
    },
    data: {
      metadata:
        "syncTimeIso" in input.metadata
          ? (buildSyncTimeTrackedMetadata({
              baseMetadata: input.metadata as SyncTimeTrackedMetadata,
              now: input.now,
              inProgressAt: input.now,
              inProgressByUserId: input.userId,
              lockToken,
            }) as any)
          : (buildStandaloneReadinessMetadata({
              baseMetadata: input.metadata as SyncReadinessTrackedMetadata,
              now: input.now,
              inProgressAt: input.now,
              inProgressByUserId: input.userId,
              lockToken,
            }) as any),
    },
  });
  return { claimed: result.count === 1, lockToken };
}

function buildRefreshRejectedReply(reason: string): string {
  if (reason === "in_progress") {
    return "A readiness refresh is already running for that post.";
  }
  if (reason === "cooldown") {
    return "That readiness post is still on cooldown.";
  }
  if (reason === "expired") {
    return "The FWA clan-list refresh window has expired.";
  }
  return "Could not refresh the readiness dashboard.";
}

async function finishRefreshEdit(input: {
  message: { edit: (payload: Record<string, unknown>) => Promise<unknown> };
  payload: SyncReadinessMessagePayload;
}): Promise<void> {
  await input.message.edit({
    content: input.payload.content,
    embeds: input.payload.embeds,
    components: input.payload.components,
  });
}

export async function updateTrackedMessageMetadataIfLockMatches(input: {
  trackedMessageId: string;
  lockToken: string;
  metadata: SyncTimeTrackedMetadata | SyncReadinessTrackedMetadata;
}): Promise<number> {
  const result = await prisma.trackedMessage.updateMany({
    where: {
      messageId: input.trackedMessageId,
      metadata:
        "syncTimeIso" in input.metadata
          ? ({ path: ["fwaClanListRefreshLockToken"], equals: input.lockToken } as any)
          : ({ path: ["refreshLockToken"], equals: input.lockToken } as any),
    },
    data: {
      metadata: input.metadata as any,
    },
  });
  return result.count;
}

export function buildSyncTimeMessageContent(epochSeconds: number, roleId: string): string {
  return `# Sync time :gem:\n\n<t:${epochSeconds}:F> (<t:${epochSeconds}:R>)\n\n<@&${roleId}>`;
}

export async function buildSyncTimeFwaClanListMessagePayload(input: {
  baseMetadata: SyncTimeTrackedMetadata;
  guildId?: string | null;
  now?: Date;
  includeRefreshButton?: boolean;
}): Promise<SyncReadinessMessagePayload> {
  return renderReadinessPayload({
    guildId: input.guildId ?? null,
    mode: "sync_time",
    now: input.now,
    baseMetadata: input.baseMetadata,
    includeRefreshButton: input.includeRefreshButton,
  });
}

export async function buildSyncReadinessMessagePayload(input: {
  baseMetadata: SyncReadinessTrackedMetadata;
  guildId?: string | null;
  now?: Date;
  includeRefreshButton?: boolean;
}): Promise<SyncReadinessMessagePayload> {
  return renderReadinessPayload({
    guildId: input.guildId ?? null,
    mode: "standalone",
    now: input.now,
    baseMetadata: input.baseMetadata,
    includeRefreshButton: input.includeRefreshButton,
  });
}

export function buildSyncReadinessMessageContent(): string {
  return buildSyncReadinessContent();
}

export function isSyncTimeFwaClanListRefreshButtonCustomId(customId: string): boolean {
  return String(customId ?? "").trim() === SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID;
}

export async function handleSyncReadinessRefreshButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!isSyncTimeFwaClanListRefreshButtonCustomId(interaction.customId)) return;

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({
      ephemeral: true,
      content: "This button can only be used in a server.",
    });
    return;
  }

  try {
    const tracked = await trackedMessageService.fetchSyncTrackedMessageWithClaims(
      interaction.message.id,
    );
    const now = new Date();
    const syncTimeMetadata = tracked ? parseSyncTimeMetadata(tracked.metadata) : null;
    const standaloneMetadata = tracked
      ? parseStandaloneReadinessMetadata(tracked.metadata)
      : null;
    const isSyncTime =
      tracked !== null &&
      tracked.status === TRACKED_MESSAGE_STATUS.ACTIVE &&
      tracked.featureType === TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST &&
      Boolean(syncTimeMetadata?.fwaClanListEnabled);
    const isStandalone =
      tracked !== null &&
      tracked.status === TRACKED_MESSAGE_STATUS.COMPLETED &&
      tracked.featureType === TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST &&
      Boolean(standaloneMetadata?.readinessEnabled);
    const metadata = (isSyncTime
      ? syncTimeMetadata
      : isStandalone
        ? standaloneMetadata
        : null) as SyncTimeTrackedMetadata | SyncReadinessTrackedMetadata | null;

    if (
      !tracked ||
      tracked.guildId !== interaction.guildId ||
      tracked.status === TRACKED_MESSAGE_STATUS.DELETED ||
      tracked.status === TRACKED_MESSAGE_STATUS.REPLACED ||
      (!isSyncTime && !isStandalone) ||
      !metadata
    ) {
      console.error(
        `[sync-time-fwa-list] refresh_failed guild_id=${interaction.guildId} message_id=${interaction.message.id} reason=invalid_tracked_message`,
      );
      await interaction.reply({
        ephemeral: true,
        content: "Could not refresh the readiness dashboard for that message.",
      });
      return;
    }

    if (isSyncTime && isReadinessRefreshWindowExpired(metadata as SyncTimeTrackedMetadata, now)) {
      console.info(
        `[sync-time-fwa-list] refresh_expired guild_id=${interaction.guildId} message_id=${interaction.message.id} expires_at=${(metadata as SyncTimeTrackedMetadata).fwaClanListRefreshExpiresAtIso ?? "missing"} now=${now.toISOString()}`,
      );
      try {
        await interaction.message.edit({
          components: [buildRefreshRow({ state: "closed" })],
        });
      } catch (err) {
        console.error(
          `[sync-time-fwa-list] refresh_failed guild_id=${interaction.guildId} message_id=${interaction.message.id} restore_error=${formatError(err)}`,
        );
      }
      await interaction.reply({
        ephemeral: true,
        content: "The FWA clan-list refresh window has expired.",
      });
      return;
    }

    const cooldownRemainingMs = getCooldownRemainingMs(metadata, now);
    if (cooldownRemainingMs > 0) {
      console.info(
        `[sync-time-fwa-list] refresh_rejected guild_id=${interaction.guildId} message_id=${interaction.message.id} reason=cooldown cooldown_remaining_ms=${cooldownRemainingMs}`,
      );
      await interaction.reply({
        ephemeral: true,
        content: `That readiness dashboard is still on cooldown for ${Math.ceil(
          cooldownRemainingMs / 1000,
        )}s.`,
      });
      return;
    }

    const claim = await tryClaimRefreshLock({
      trackedMessageId: tracked.messageId,
      updatedAt: tracked.updatedAt,
      now,
      userId: interaction.user.id,
      metadata,
    });
    if (!claim.claimed) {
      const current = await trackedMessageService.fetchSyncTrackedMessageWithClaims(
        interaction.message.id,
      );
      const currentSyncTime = current ? parseSyncTimeMetadata(current.metadata) : null;
      const currentStandalone = current ? parseStandaloneReadinessMetadata(current.metadata) : null;
      const currentMetadata =
        currentSyncTime?.fwaClanListRefreshInProgressAtIso
          ? currentSyncTime
          : currentStandalone?.refreshInProgressAtIso
            ? currentStandalone
            : currentSyncTime?.fwaClanListLastSuccessfulRefreshAtIso
              ? currentSyncTime
              : currentStandalone?.lastSuccessfulRefreshAtIso
                ? currentStandalone
                : null;
      const reason = currentMetadata
        ? currentSyncTime?.fwaClanListRefreshInProgressAtIso ||
          currentStandalone?.refreshInProgressAtIso
          ? "in_progress"
          : getCooldownRemainingMs(currentMetadata, now) > 0
            ? "cooldown"
            : "changed"
        : "changed";
      console.info(
        `[sync-time-fwa-list] refresh_rejected guild_id=${interaction.guildId} message_id=${interaction.message.id} reason=${reason}`,
      );
      await interaction.reply({
        ephemeral: true,
        content: buildRefreshRejectedReply(reason),
      });
      return;
    }

    const startedAt = now;
    const lockToken = claim.lockToken;
    let releaseMetadata: SyncTimeTrackedMetadata | SyncReadinessTrackedMetadata | null =
      stripRefreshLockMetadata(metadata as SyncTimeTrackedMetadata | SyncReadinessTrackedMetadata);
    try {
      console.info(
        `[sync-time-fwa-list] refresh_started guild_id=${interaction.guildId} message_id=${interaction.message.id} mode=${isSyncTime ? "sync_time" : "standalone"} user_id=${interaction.user.id}`,
      );
      await interaction.deferUpdate();
      await interaction.message.edit({
        components: [buildRefreshRow({ state: "refreshing" })],
      });

      const summary = await refreshTrackedClanReadinessState({
        guildId: interaction.guildId,
      });
      if (
        summary.syncAllFailedClanTags.length > 0 ||
        summary.currentMemberFailedClanTags.length > 0
      ) {
        console.info(
          `[sync-time-fwa-list] refresh_partial_upstream guild_id=${interaction.guildId} message_id=${interaction.message.id} tracked_clan_count=${summary.trackedClanCount} sync_failed_clan_count=${summary.syncAllFailedClanTags.length} member_failed_clan_count=${summary.currentMemberFailedClanTags.length}`,
        );
      }

      let payload = isSyncTime
        ? await buildSyncTimeFwaClanListMessagePayload({
            baseMetadata: metadata as SyncTimeTrackedMetadata,
            guildId: tracked.guildId,
            now,
          })
        : await buildSyncReadinessMessagePayload({
            baseMetadata: metadata as SyncReadinessTrackedMetadata,
            guildId: tracked.guildId,
            now,
          });
      const failedClanCount =
        summary.syncAllFailedClanTags.length + summary.currentMemberFailedClanTags.length;
      if (failedClanCount > 0) {
        payload = {
          ...payload,
          content: `${payload.content}\n\n⚠️ Refresh completed with ${failedClanCount} clan refresh failure${
            failedClanCount === 1 ? "" : "s"
          }.`,
        };
      }

      await finishRefreshEdit({
        message: interaction.message,
        payload,
      });

      const completedAt = new Date();
      releaseMetadata = isSyncTime
        ? buildSyncTimeTrackedMetadata({
            baseMetadata: stripRefreshLockMetadata(metadata as SyncTimeTrackedMetadata),
            now: completedAt,
            successfulRefreshAt: completedAt,
          })
        : buildStandaloneReadinessMetadata({
            baseMetadata: stripRefreshLockMetadata(metadata as SyncReadinessTrackedMetadata),
            now: completedAt,
            successfulRefreshAt: completedAt,
          });

      console.info(
        `[sync-time-fwa-list] refresh_success guild_id=${interaction.guildId} message_id=${tracked.messageId} duration_ms=${completedAt.getTime() - startedAt.getTime()} tracked_clan_count=${payload.trackedClanCount} failed_clan_count=${failedClanCount}`,
      );
    } catch (err) {
      console.error(
        `[sync-time-fwa-list] refresh_failed guild_id=${interaction.guildId} message_id=${tracked.messageId} error=${formatError(err)}`,
      );
      try {
        await interaction.message.edit({
          components: [
            buildRefreshRow({
              state:
                isSyncTime &&
                isReadinessRefreshWindowExpired(metadata as SyncTimeTrackedMetadata, now)
                  ? "closed"
                  : "default",
            }),
          ],
        });
      } catch (restoreErr) {
        console.error(
          `[sync-time-fwa-list] refresh_failed guild_id=${interaction.guildId} message_id=${tracked.messageId} restore_error=${formatError(restoreErr)}`,
        );
      }
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to refresh the readiness dashboard.",
        });
      } else {
        await interaction.followUp({
          ephemeral: true,
          content: "Failed to refresh the readiness dashboard.",
        });
      }
    } finally {
      if (releaseMetadata && lockToken) {
        try {
          const releasedRows = await updateTrackedMessageMetadataIfLockMatches({
            trackedMessageId: tracked.messageId,
            lockToken,
            metadata: releaseMetadata,
          });
          if (releasedRows === 0) {
            console.info(
              `[sync-time-fwa-list] refresh_released_stale guild_id=${interaction.guildId} message_id=${tracked.messageId}`,
            );
          }
        } catch (err) {
          console.error(
            `[sync-time-fwa-list] refresh_failed guild_id=${interaction.guildId} message_id=${tracked.messageId} release_error=${formatError(err)}`,
          );
        }
      }
    }
  } catch (err) {
    console.error(
      `[sync-time-fwa-list] refresh_failed guild_id=${interaction.guildId} message_id=${interaction.message.id} error=${formatError(err)}`,
    );
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        ephemeral: true,
        content: "Failed to refresh the readiness dashboard.",
      });
      return;
    }
    await interaction.followUp({
      ephemeral: true,
      content: "Failed to refresh the readiness dashboard.",
    });
  }
}

export async function handleSyncTimeFwaClanListRefreshButton(
  interaction: ButtonInteraction,
): Promise<void> {
  return handleSyncReadinessRefreshButton(interaction);
}
