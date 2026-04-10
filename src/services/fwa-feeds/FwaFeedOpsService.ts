import { prisma } from "../../prisma";
import { normalizeFwaTag } from "./normalize";
import { FwaClansCatalogSyncService } from "./FwaClansCatalogSyncService";
import { FwaClanMembersSyncService } from "./FwaClanMembersSyncService";
import { FwaWarMembersSyncService } from "./FwaWarMembersSyncService";
import { FwaClanWarsSyncService } from "./FwaClanWarsSyncService";
import { FwaClanWarsWatchService } from "./FwaClanWarsWatchService";
import { FwaFeedSchedulerService } from "./FwaFeedSchedulerService";
import { FwaTrackedClanWarRosterSyncService } from "./FwaTrackedClanWarRosterSyncService";

/** Purpose: expose manual status/run/watch operations for fwa-feed ingestion without command-surface expansion. */
export class FwaFeedOpsService {
  private readonly clansSync = new FwaClansCatalogSyncService();
  private readonly clanMembersSync = new FwaClanMembersSyncService();
  private readonly warMembersSync = new FwaWarMembersSyncService();
  private readonly clanWarsSync = new FwaClanWarsSyncService();
  private readonly trackedRosterSync = new FwaTrackedClanWarRosterSyncService();
  private readonly watchService = new FwaClanWarsWatchService(
    this.clanWarsSync,
    this.warMembersSync,
    this.trackedRosterSync,
  );
  private readonly scheduler = new FwaFeedSchedulerService();

  /** Purpose: return feed sync-state rows for global jobs and optional per-clan scopes. */
  async status(clanTag?: string) {
    const normalized = clanTag ? normalizeFwaTag(clanTag) : null;
    const where = normalized
      ? {
          OR: [
            { scopeType: "GLOBAL" as const },
            { scopeType: "TRACKED_CLANS" as const },
            { scopeType: "CLAN_TAG" as const, scopeKey: normalized },
          ],
        }
      : undefined;
    const syncStateRows = await prisma.fwaFeedSyncState.findMany({
      where,
      orderBy: [{ feedType: "asc" }, { scopeType: "asc" }, { scopeKey: "asc" }],
    });
    const watchRows = await this.watchService.getWatchStatus(normalized ?? undefined);
    return {
      syncStateRows,
      watchRows,
    };
  }

  /** Purpose: run one tracked-clan one-off sync for clan-members or clan-wars feeds. */
  async runTracked(feed: "clan-members" | "clan-wars" | "war-roster", clanTag: string) {
    const normalized = normalizeFwaTag(clanTag);
    if (!normalized) throw new Error("Invalid clan tag");
    if (feed === "clan-members") {
      return this.clanMembersSync.syncTrackedClan(normalized, { force: true });
    }
    if (feed === "war-roster") {
      const warMembersResult = await this.warMembersSync.syncClan(normalized, { force: true });
      const rosterResult = await this.trackedRosterSync.syncClan(normalized);
      return {
        warMembersResult,
        rosterResult,
      };
    }
    return this.clanWarsSync.syncClan(normalized, { force: true });
  }

  /** Purpose: run one global one-off sync tick for configured feed families. */
  async runGlobal(feed: "clans" | "war-members" | "clan-wars") {
    if (feed === "clans") {
      return this.clansSync.syncGlobalCatalog({ force: true });
    }
    if (feed === "war-members") {
      return this.warMembersSync.runDistributedSweep({
        chunkSize: 6,
        concurrency: 4,
        force: true,
      });
    }
    return this.clanWarsSync.runDistributedSweep({
      chunkSize: 20,
      concurrency: 4,
      force: true,
    });
  }

  /** Purpose: run one scheduler job tick manually for debugging operational behavior. */
  async runSchedulerJob(
    job: "clans" | "clan-members" | "war-members" | "tracked-clan-wars-watch" | "global-clan-wars",
  ): Promise<void> {
    if (job === "clans") {
      await this.scheduler.runClansJob();
      return;
    }
    if (job === "clan-members") {
      await this.scheduler.runTrackedClanMembersJob();
      return;
    }
    if (job === "war-members") {
      await this.scheduler.runWarMembersSweepJob();
      return;
    }
    if (job === "tracked-clan-wars-watch") {
      await this.scheduler.runTrackedClanWarsWatchJob();
      return;
    }
    await this.scheduler.runGlobalClanWarsSweepJob();
  }

  /** Purpose: load per-clan tracked watch state for direct watch-status checks. */
  async watchStatus(clanTag?: string) {
    const normalized = clanTag ? normalizeFwaTag(clanTag) : null;
    return this.watchService.getWatchStatus(normalized ?? undefined);
  }
}
