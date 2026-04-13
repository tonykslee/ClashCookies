import type { Client } from "discord.js";
import { prisma } from "../prisma";
import { BotLogChannelService } from "./BotLogChannelService";
import { CommandPermissionService } from "./CommandPermissionService";
import { SettingsService } from "./SettingsService";
import { formatError } from "../helper/formatError";
import { getHeatMapRefBandKey } from "../helper/compoHeatMap";
import {
  buildHeatMapRefRebuildCycleKey,
  buildHeatMapRefRebuildRows,
  computeHeatMapRefRebuildContentHash,
  computeHeatMapRefRebuildDueAt,
  type HeatMapRefBandDefinition,
  type HeatMapRefBucketCounts,
  type HeatMapRefRebuildExcludedRoster,
  type HeatMapRefRebuildQualifiedRoster,
  type HeatMapRefRebuildRow,
  type HeatMapRefRebuildSourceRoster,
} from "../helper/heatMapRefRebuild";
import { normalizeFwaTag } from "./fwa-feeds/normalize";
import { HEAT_MAP_REF_SEED_ROWS } from "./HeatMapRefSeedData";
import { getAllHeatMapRefs } from "./HeatMapRefService";
import {
  parseSyncTimeMetadata,
  trackedMessageService,
} from "./TrackedMessageService";
import { isMirrorPollingMode, type PollingMode } from "./PollingModeService";

const HEAT_MAP_REF_REBUILD_STATE_KEY_PREFIX = "heatmapref_rebuild_state";

type HeatMapRefRebuildCheckpoint = {
  cycleKey: string;
  anchoredSyncTimeIso: string;
  dueAtIso: string;
  status: "scheduled" | "running" | "success" | "failed" | "no_op";
  lastAttemptAtIso: string | null;
  lastSuccessAtIso: string | null;
  failureReason: string | null;
  contentHash: string | null;
  roleId: string | null;
};

export type HeatMapRefRebuildRunResult = {
  status: "success" | "noop" | "skipped" | "failed";
  reason: string | null;
  cycleKey: string | null;
  dueAt: Date | null;
  trackedClanCount: number;
  sourceRosterCount: number;
  qualifyingRosterCount: number;
  excludedRosterCount: number;
  rowCount: number;
  changedRowCount: number;
  contentHash: string | null;
  alertSent: boolean;
  summaryLines: string[];
};

type RebuildCycleContext = {
  messageId: string;
  syncTimeIso: string;
  syncEpochSeconds: number;
  cycleKey: string;
  dueAt: Date;
  roleId: string | null;
};

function checkpointKey(guildId: string): string {
  return `${HEAT_MAP_REF_REBUILD_STATE_KEY_PREFIX}:${guildId}`;
}

function parseCheckpoint(raw: string | null): HeatMapRefRebuildCheckpoint | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HeatMapRefRebuildCheckpoint>;
    const legacyParsed = JSON.parse(raw) as {
      cycleKey?: unknown;
      status?: unknown;
      completedAtIso?: unknown;
      contentHash?: unknown;
    };
    if (typeof parsed.cycleKey === "string" && parsed.cycleKey.trim()) {
      if (
        (parsed.status === "scheduled" ||
          parsed.status === "running" ||
          parsed.status === "success" ||
          parsed.status === "failed" ||
          parsed.status === "no_op") &&
        typeof parsed.anchoredSyncTimeIso === "string" &&
        typeof parsed.dueAtIso === "string"
      ) {
        return {
          cycleKey: parsed.cycleKey.trim(),
          anchoredSyncTimeIso: parsed.anchoredSyncTimeIso,
          dueAtIso: parsed.dueAtIso,
          status: parsed.status,
          lastAttemptAtIso:
            typeof parsed.lastAttemptAtIso === "string" ? parsed.lastAttemptAtIso : null,
          lastSuccessAtIso:
            typeof parsed.lastSuccessAtIso === "string" ? parsed.lastSuccessAtIso : null,
          failureReason:
            typeof parsed.failureReason === "string" ? parsed.failureReason : null,
          contentHash: typeof parsed.contentHash === "string" ? parsed.contentHash : null,
          roleId: typeof parsed.roleId === "string" ? parsed.roleId : null,
        };
      }

      if (
        (legacyParsed.status === "success" ||
          legacyParsed.status === "noop" ||
          legacyParsed.status === "failed") &&
        typeof legacyParsed.completedAtIso === "string"
      ) {
        return {
          cycleKey: parsed.cycleKey.trim(),
          anchoredSyncTimeIso: legacyParsed.completedAtIso,
          dueAtIso: legacyParsed.completedAtIso,
          status: legacyParsed.status === "noop" ? "no_op" : (legacyParsed.status as "success" | "failed"),
          lastAttemptAtIso: legacyParsed.completedAtIso,
          lastSuccessAtIso: legacyParsed.status === "failed" ? null : legacyParsed.completedAtIso,
          failureReason: null,
          contentHash: typeof legacyParsed.contentHash === "string" ? legacyParsed.contentHash : null,
          roleId: null,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function stringifyCheckpoint(value: HeatMapRefRebuildCheckpoint): string {
  return JSON.stringify(value);
}

function buildCheckpointForCycle(input: {
  cycle: RebuildCycleContext;
}): HeatMapRefRebuildCheckpoint {
  return {
    cycleKey: input.cycle.cycleKey,
    anchoredSyncTimeIso: input.cycle.syncTimeIso,
    dueAtIso: input.cycle.dueAt.toISOString(),
    status: "scheduled",
    lastAttemptAtIso: null,
    lastSuccessAtIso: null,
    failureReason: null,
    contentHash: null,
    roleId: input.cycle.roleId,
  };
}

function isTerminalCheckpointStatus(status: HeatMapRefRebuildCheckpoint["status"]): boolean {
  return status === "success" || status === "failed" || status === "no_op";
}

function buildSeedBandDefinitions(): HeatMapRefBandDefinition[] {
  return HEAT_MAP_REF_SEED_ROWS.map((row) => ({
    weightMinInclusive: row.weightMinInclusive,
    weightMaxInclusive: row.weightMaxInclusive,
  }));
}

function buildSeedCountsByBandKey(): ReadonlyMap<string, HeatMapRefBucketCounts> {
  return new Map(
    HEAT_MAP_REF_SEED_ROWS.map((row) => [
      getHeatMapRefBandKey(row),
      {
        th18Count: row.th18Count,
        th17Count: row.th17Count,
        th16Count: row.th16Count,
        th15Count: row.th15Count,
        th14Count: row.th14Count,
        th13Count: row.th13Count,
        th12Count: row.th12Count,
        th11Count: row.th11Count,
        th10OrLowerCount: row.th10OrLowerCount,
      },
    ]),
  );
}

function buildSourceRosters(
  members: Array<{
    clanTag: string;
    playerTag: string;
    position: number | null;
    townHall: number | null;
    weight: number | null;
    sourceSyncedAt: Date;
  }>,
): HeatMapRefRebuildSourceRoster[] {
  const byClanTag = new Map<string, HeatMapRefRebuildSourceRoster>();
  for (const member of members) {
    const clanTag = normalizeFwaTag(member.clanTag);
    if (!clanTag) continue;
    const current = byClanTag.get(clanTag) ?? {
      clanTag,
      members: [],
    };
    current.members.push({
      clanTag,
      playerTag: member.playerTag,
      position: member.position,
      townHall: member.townHall,
      weight: member.weight,
      sourceSyncedAt: member.sourceSyncedAt,
    });
    byClanTag.set(clanTag, current);
  }
  return [...byClanTag.values()].sort((left, right) => left.clanTag.localeCompare(right.clanTag));
}

function buildSummaryLines(input: {
  trackedClanCount: number;
  sourceRosterCount: number;
  qualifyingRosters: HeatMapRefRebuildQualifiedRoster[];
  excludedRosters: HeatMapRefRebuildExcludedRoster[];
  rows: HeatMapRefRebuildRow[];
  status: "success" | "noop" | "failed";
  reason: string | null;
}): string[] {
  const lines = [
    `tracked clans: ${input.trackedClanCount}`,
    `source rosters: ${input.sourceRosterCount}`,
    `qualifying rosters: ${input.qualifyingRosters.length}`,
    `excluded rosters: ${input.excludedRosters.length}`,
    `heatmap rows: ${input.rows.length}`,
    `result: ${input.status}`,
  ];
  if (input.reason) {
    lines.push(`reason: ${input.reason}`);
  }
  const excludedPreview = input.excludedRosters
    .slice(0, 3)
    .map((row) => `${row.clanTag} (${row.reason})`);
  if (excludedPreview.length > 0) {
    lines.push(`excluded preview: ${excludedPreview.join("; ")}`);
  }
  return lines;
}

/** Purpose: rebuild HeatMapRef from persisted FWA WarMembers rows with deterministic seed blending and no-op detection. */
export class HeatMapRefRebuildService {
  private readonly settings: SettingsService;
  private readonly botLogChannels: BotLogChannelService;
  private readonly permissions: CommandPermissionService;

  constructor(input?: {
    settings?: SettingsService;
    botLogChannels?: BotLogChannelService;
    permissions?: CommandPermissionService;
  }) {
    this.settings = input?.settings ?? new SettingsService();
    this.botLogChannels = input?.botLogChannels ?? new BotLogChannelService();
    this.permissions = input?.permissions ?? new CommandPermissionService(this.settings);
  }

  /** Purpose: rebuild HeatMapRef directly from persisted source tables without any scheduling or alert side-effects. */
  async rebuildHeatMapRef(now: Date = new Date()): Promise<HeatMapRefRebuildRunResult> {
    const trackedClans = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true },
    });
    const trackedClanTags = [...new Set(trackedClans.map((row) => normalizeFwaTag(row.tag)).filter(Boolean))];
    if (trackedClanTags.length === 0) {
      return {
        status: "skipped",
        reason: "no tracked FWA clans are configured",
        cycleKey: null,
        dueAt: null,
        trackedClanCount: 0,
        sourceRosterCount: 0,
        qualifyingRosterCount: 0,
        excludedRosterCount: 0,
        rowCount: 0,
        changedRowCount: 0,
        contentHash: null,
        alertSent: false,
        summaryLines: ["No tracked FWA clans are configured."],
      };
    }

    const members = await prisma.fwaWarMemberCurrent.findMany({
      where: { clanTag: { in: trackedClanTags } },
      orderBy: [{ clanTag: "asc" }, { position: "asc" }, { playerTag: "asc" }],
      select: {
        clanTag: true,
        playerTag: true,
        position: true,
        townHall: true,
        weight: true,
        sourceSyncedAt: true,
      },
    });

    const sourceRosters = buildSourceRosters(members);
    const seedBands = buildSeedBandDefinitions();
    const seedRowsByBandKey = buildSeedCountsByBandKey();
    const rebuiltResult = buildHeatMapRefRebuildRows({
      sourceRosters,
      seedBands,
      seedRowsByBandKey,
      now,
    });
    const rebuilt = rebuiltResult.rows;
    const currentRows = await getAllHeatMapRefs();
    const currentComparableRows = currentRows.map((row) => ({
      weightMinInclusive: row.weightMinInclusive,
      weightMaxInclusive: row.weightMaxInclusive,
      th18Count: row.th18Count,
      th17Count: row.th17Count,
      th16Count: row.th16Count,
      th15Count: row.th15Count,
      th14Count: row.th14Count,
      th13Count: row.th13Count,
      th12Count: row.th12Count,
      th11Count: row.th11Count,
      th10OrLowerCount: row.th10OrLowerCount,
      contributingClanCount: row.contributingClanCount,
      sourceVersion: row.sourceVersion,
      refreshedAt: row.refreshedAt,
    }));
    const currentHash = computeHeatMapRefRebuildContentHash(currentComparableRows as HeatMapRefRebuildRow[]);
    const nextHash = computeHeatMapRefRebuildContentHash(rebuilt);
    if (currentHash === nextHash) {
      return {
        status: "noop",
        reason: "rebuilt content matched the stored HeatMapRef rows",
        cycleKey: null,
        dueAt: null,
        trackedClanCount: trackedClanTags.length,
        sourceRosterCount: sourceRosters.length,
        qualifyingRosterCount: rebuiltResult.qualifyingRosters.length,
        excludedRosterCount: rebuiltResult.excludedRosters.length,
        rowCount: rebuilt.length,
        changedRowCount: 0,
        contentHash: nextHash,
        alertSent: false,
        summaryLines: buildSummaryLines({
          trackedClanCount: trackedClanTags.length,
          sourceRosterCount: sourceRosters.length,
          qualifyingRosters: rebuiltResult.qualifyingRosters,
          excludedRosters: rebuiltResult.excludedRosters,
          rows: rebuilt,
          status: "noop",
          reason: "rebuilt content matched the stored HeatMapRef rows",
        }),
      };
    }

    await prisma.$transaction(async (tx) => {
      await tx.heatMapRef.deleteMany({});
      if (rebuilt.length > 0) {
        await tx.heatMapRef.createMany({
          data: rebuilt.map((row) => ({
            weightMinInclusive: row.weightMinInclusive,
            weightMaxInclusive: row.weightMaxInclusive,
            th18Count: row.th18Count,
            th17Count: row.th17Count,
            th16Count: row.th16Count,
            th15Count: row.th15Count,
            th14Count: row.th14Count,
            th13Count: row.th13Count,
            th12Count: row.th12Count,
            th11Count: row.th11Count,
            th10OrLowerCount: row.th10OrLowerCount,
            contributingClanCount: row.contributingClanCount,
            sourceVersion: row.sourceVersion,
            refreshedAt: row.refreshedAt,
          })),
        });
      }
    });

    const result = buildSummaryLines({
      trackedClanCount: trackedClanTags.length,
      sourceRosterCount: sourceRosters.length,
      qualifyingRosters: rebuiltResult.qualifyingRosters,
      excludedRosters: rebuiltResult.excludedRosters,
      rows: rebuilt,
      status: "success",
      reason: null,
    });
    return {
      status: "success",
      reason: null,
      cycleKey: null,
      dueAt: null,
      trackedClanCount: trackedClanTags.length,
      sourceRosterCount: sourceRosters.length,
      qualifyingRosterCount: rebuiltResult.qualifyingRosters.length,
      excludedRosterCount: rebuiltResult.excludedRosters.length,
      rowCount: rebuilt.length,
      changedRowCount: rebuilt.length,
      contentHash: nextHash,
      alertSent: false,
      summaryLines: result,
    };
  }

  /** Purpose: run the rebuild once when a sync cycle is due and persist a single-cycle checkpoint. */
  async runScheduledRebuildCycle(input: {
    client: Client;
    guildId: string;
    now?: Date;
    pollingMode?: PollingMode;
  }): Promise<HeatMapRefRebuildRunResult> {
    const now = input.now ?? new Date();
    if (isMirrorPollingMode({ POLLING_MODE: input.pollingMode })) {
      return {
        status: "skipped",
        reason: "mirror mode does not run HeatMapRef rebuilds locally",
        cycleKey: null,
        dueAt: null,
        trackedClanCount: 0,
        sourceRosterCount: 0,
        qualifyingRosterCount: 0,
        excludedRosterCount: 0,
        rowCount: 0,
        changedRowCount: 0,
        contentHash: null,
        alertSent: false,
        summaryLines: ["Mirror mode skip."],
      };
    }

    const latestCycle = await this.resolveCurrentCycle(input.guildId);
    if (!latestCycle) {
      return {
        status: "skipped",
        reason: "no active sync-time cycle is configured",
        cycleKey: null,
        dueAt: null,
        trackedClanCount: 0,
        sourceRosterCount: 0,
        qualifyingRosterCount: 0,
        excludedRosterCount: 0,
        rowCount: 0,
        changedRowCount: 0,
        contentHash: null,
        alertSent: false,
        summaryLines: ["No active sync-time cycle is configured."],
      };
    }

    const checkpoint = await this.readCheckpoint(input.guildId);
    const activeCheckpoint = await this.ensureCheckpointForLatestCycle({
      guildId: input.guildId,
      latestCycle,
      checkpoint,
    });

    if (activeCheckpoint.status === "running") {
      return {
        status: "skipped",
        reason: `cycle ${activeCheckpoint.cycleKey} is already running`,
        cycleKey: activeCheckpoint.cycleKey,
        dueAt: new Date(activeCheckpoint.dueAtIso),
        trackedClanCount: 0,
        sourceRosterCount: 0,
        qualifyingRosterCount: 0,
        excludedRosterCount: 0,
        rowCount: 0,
        changedRowCount: 0,
        contentHash: activeCheckpoint.contentHash,
        alertSent: false,
        summaryLines: [
          `Cycle ${activeCheckpoint.cycleKey} is already running.`,
        ],
      };
    }

    if (isTerminalCheckpointStatus(activeCheckpoint.status)) {
      return {
        status: "skipped",
        reason: `cycle ${activeCheckpoint.cycleKey} already handled with ${activeCheckpoint.status}`,
        cycleKey: activeCheckpoint.cycleKey,
        dueAt: new Date(activeCheckpoint.dueAtIso),
        trackedClanCount: 0,
        sourceRosterCount: 0,
        qualifyingRosterCount: 0,
        excludedRosterCount: 0,
        rowCount: 0,
        changedRowCount: 0,
        contentHash: activeCheckpoint.contentHash,
        alertSent: false,
        summaryLines: [
          `Cycle ${activeCheckpoint.cycleKey} already handled with status ${activeCheckpoint.status}.`,
        ],
      };
    }

    const dueAt = new Date(activeCheckpoint.dueAtIso);
    if (Number.isNaN(dueAt.getTime())) {
      return {
        status: "skipped",
        reason: "stored rebuild checkpoint due time is invalid",
        cycleKey: activeCheckpoint.cycleKey,
        dueAt: null,
        trackedClanCount: 0,
        sourceRosterCount: 0,
        qualifyingRosterCount: 0,
        excludedRosterCount: 0,
        rowCount: 0,
        changedRowCount: 0,
        contentHash: null,
        alertSent: false,
        summaryLines: [
          `Stored checkpoint for cycle ${activeCheckpoint.cycleKey} has an invalid due time.`,
        ],
      };
    }
    if (now.getTime() < dueAt.getTime()) {
      return {
        status: "skipped",
        reason: "rebuild is not due yet",
        cycleKey: activeCheckpoint.cycleKey,
        dueAt,
        trackedClanCount: 0,
        sourceRosterCount: 0,
        qualifyingRosterCount: 0,
        excludedRosterCount: 0,
        rowCount: 0,
        changedRowCount: 0,
        contentHash: null,
        alertSent: false,
        summaryLines: [`Rebuild due at <t:${Math.floor(dueAt.getTime() / 1000)}:F>.`],
      };
    }

    await this.writeCheckpoint(input.guildId, {
      ...activeCheckpoint,
      status: "running",
      lastAttemptAtIso: now.toISOString(),
      failureReason: null,
    });

    try {
      const result = await this.rebuildHeatMapRef(now);
      const finalStatus =
        result.status === "noop" || result.status === "skipped" ? "no_op" : "success";
      await this.writeCheckpoint(input.guildId, {
        ...activeCheckpoint,
        status: finalStatus,
        lastAttemptAtIso: now.toISOString(),
        lastSuccessAtIso: now.toISOString(),
        failureReason: null,
        contentHash: result.contentHash,
      });
      return {
        ...result,
        cycleKey: activeCheckpoint.cycleKey,
        dueAt,
      };
    } catch (error) {
      const reason = formatError(error);
      await this.writeCheckpoint(input.guildId, {
        ...activeCheckpoint,
        status: "failed",
        lastAttemptAtIso: now.toISOString(),
        failureReason: reason,
        contentHash: null,
      });
      const alertSent = await this.sendFailureAlert({
        client: input.client,
        guildId: input.guildId,
        cycle: activeCheckpoint,
        reason,
      });
      return {
        status: "failed",
        reason,
        cycleKey: activeCheckpoint.cycleKey,
        dueAt,
        trackedClanCount: 0,
        sourceRosterCount: 0,
        qualifyingRosterCount: 0,
        excludedRosterCount: 0,
        rowCount: 0,
        changedRowCount: 0,
        contentHash: null,
        alertSent,
        summaryLines: [
          `Rebuild failed: ${reason}`,
          `Alert sent: ${alertSent ? "yes" : "no"}`,
        ],
      };
    }
  }

  /** Purpose: run the same deterministic rebuild logic for manual repair flows. */
  async runManualRepair(input: {
    guildId: string;
    now?: Date;
  }): Promise<HeatMapRefRebuildRunResult> {
    const now = input.now ?? new Date();
    try {
      const result = await this.rebuildHeatMapRef(now);
      const latestCycle = await this.resolveCurrentCycle(input.guildId);
      if (latestCycle) {
        const checkpoint = await this.ensureCheckpointForLatestCycle({
          guildId: input.guildId,
          latestCycle,
          checkpoint: await this.readCheckpoint(input.guildId),
        });
        await this.writeCheckpoint(input.guildId, {
          ...checkpoint,
          status:
            result.status === "noop" || result.status === "skipped" ? "no_op" : "success",
          lastAttemptAtIso: now.toISOString(),
          lastSuccessAtIso: now.toISOString(),
          failureReason: null,
          contentHash: result.contentHash,
        });
      }
      return result;
    } catch (error) {
      return {
        status: "failed",
        reason: formatError(error),
        cycleKey: null,
        dueAt: null,
        trackedClanCount: 0,
        sourceRosterCount: 0,
        qualifyingRosterCount: 0,
        excludedRosterCount: 0,
        rowCount: 0,
        changedRowCount: 0,
        contentHash: null,
        alertSent: false,
        summaryLines: [`Rebuild failed: ${formatError(error)}`],
      };
    }
  }

  private async resolveCurrentCycle(guildId: string): Promise<RebuildCycleContext | null> {
    const tracked = await trackedMessageService.resolveLatestActiveSyncPost(guildId);
    if (!tracked) return null;
    const metadata = parseSyncTimeMetadata(tracked.metadata);
    if (!metadata) return null;
    const cycleKey = buildHeatMapRefRebuildCycleKey({
      messageId: tracked.messageId,
      syncEpochSeconds: metadata.syncEpochSeconds,
    });
    return {
      messageId: tracked.messageId,
      syncTimeIso: metadata.syncTimeIso,
      syncEpochSeconds: metadata.syncEpochSeconds,
      cycleKey,
      dueAt: computeHeatMapRefRebuildDueAt(metadata.syncEpochSeconds),
      roleId: metadata.roleId || null,
    };
  }

  private async readCheckpoint(guildId: string): Promise<HeatMapRefRebuildCheckpoint | null> {
    const raw = await this.settings.get(checkpointKey(guildId));
    return parseCheckpoint(raw);
  }

  private async ensureCheckpointForLatestCycle(input: {
    guildId: string;
    latestCycle: RebuildCycleContext;
    checkpoint: HeatMapRefRebuildCheckpoint | null;
  }): Promise<HeatMapRefRebuildCheckpoint> {
    const existing = input.checkpoint;
    if (existing && !isTerminalCheckpointStatus(existing.status)) {
      return existing;
    }
    if (existing && existing.cycleKey === input.latestCycle.cycleKey) {
      return existing;
    }

    const nextCheckpoint = buildCheckpointForCycle({
      cycle: input.latestCycle,
    });
    await this.writeCheckpoint(input.guildId, nextCheckpoint);
    return nextCheckpoint;
  }

  private async writeCheckpoint(
    guildId: string,
    value: HeatMapRefRebuildCheckpoint,
  ): Promise<void> {
    await this.settings.set(checkpointKey(guildId), stringifyCheckpoint(value));
  }

  private async sendFailureAlert(input: {
    client: Client;
    guildId: string;
    cycle: Pick<HeatMapRefRebuildCheckpoint, "anchoredSyncTimeIso" | "roleId">;
    reason: string;
  }): Promise<boolean> {
    const roleId =
      (await this.permissions.getFwaLeaderRoleId(input.guildId).catch(() => null)) ||
      input.cycle.roleId;
    const roleMention = roleId ? `<@&${roleId}>` : "configured FWA leader role";
    const anchoredTime = new Date(input.cycle.anchoredSyncTimeIso);
    const anchoredSyncSeconds = Number.isNaN(anchoredTime.getTime())
      ? null
      : Math.floor(anchoredTime.getTime() / 1000);
    const message = [
      anchoredSyncSeconds
        ? `HeatMapRef rebuild failed for <t:${anchoredSyncSeconds}:F> (<t:${anchoredSyncSeconds}:R>).`
        : "HeatMapRef rebuild failed for the anchored sync cycle.",
      `FWA leader role: ${roleMention}.`,
      `Reason: ${input.reason}`,
      "Repair: run `/force refresh heatmapref` after fixing the persisted FWA feed rows.",
    ].join("\n");

    const channelIds: string[] = [];
    const botLogChannelId = await this.botLogChannels
      .getChannelId(input.guildId)
      .catch(() => null);
    if (botLogChannelId) {
      channelIds.push(botLogChannelId);
    }
    const trackedClanRows = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { logChannelId: true },
    });
    for (const row of trackedClanRows) {
      const logChannelId = String(row.logChannelId ?? "").trim();
      if (!logChannelId || channelIds.includes(logChannelId)) continue;
      channelIds.push(logChannelId);
    }

    const guild = await input.client.guilds.fetch(input.guildId).catch(() => null);
    if (!guild) {
      console.error(`[heatmapref] alert_failed guild=${input.guildId} reason=guild_unavailable`);
      return false;
    }

    for (const channelId of channelIds) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        continue;
      }
      try {
        await channel.send({
          content: message,
          allowedMentions: roleId ? { roles: [roleId] } : undefined,
        });
        return true;
      } catch (error) {
        console.warn(
          `[heatmapref] alert_send_failed channel=${channelId} error=${formatError(error)}`,
        );
      }
    }

    console.error(
      `[heatmapref] alert_failed guild=${input.guildId} reason=no_sendable_alert_channel`,
    );
    return false;
  }
}

export const parseHeatMapRefRebuildCheckpointForTest = parseCheckpoint;
export const buildHeatMapRefRebuildSeedBandsForTest = buildSeedBandDefinitions;
