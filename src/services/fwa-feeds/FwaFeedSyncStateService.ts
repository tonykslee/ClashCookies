import type {
  FwaFeedScopeType,
  FwaFeedSyncStatus,
  FwaFeedType,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../prisma";
import { resolveFwaFeedScopeKey } from "./scopeKey";

type SyncScope = {
  feedType: FwaFeedType;
  scopeType: FwaFeedScopeType;
  scopeKey: string | null;
};

type RecordSuccessParams = SyncScope & {
  rowCount: number;
  changedRowCount: number;
  contentHash: string | null;
  status: FwaFeedSyncStatus;
  nextEligibleAt: Date | null;
};

type RecordFailureParams = SyncScope & {
  errorCode: string;
  errorSummary: string;
  nextEligibleAt: Date | null;
};

type SyncStateClient = typeof prisma | Prisma.TransactionClient;

type ExpectedAttemptAt = Date | undefined;

/** Purpose: own persistent sync-state metadata updates for all fwa feed scopes. */
export class FwaFeedSyncStateService {
  private getDelegate(client: SyncStateClient = prisma) {
    return client.fwaFeedSyncState as any;
  }

  private resolveScope(scope: SyncScope): SyncScope & { scopeKey: string } {
    return {
      ...scope,
      scopeKey: resolveFwaFeedScopeKey(scope),
    };
  }

  private buildCompoundScopeWhere(scope: SyncScope) {
    const resolved = this.resolveScope(scope);
    return {
      feedType_scopeType_scopeKey: {
        feedType: resolved.feedType,
        scopeType: resolved.scopeType,
        scopeKey: resolved.scopeKey,
      },
    };
  }

  /** Purpose: identify the per-clan Members.json scope that shares row and metadata ownership. */
  private requiresClanMembersFence(scope: SyncScope): boolean {
    return scope.feedType === "CLAN_MEMBERS" && scope.scopeType === "CLAN_TAG";
  }

  /** Purpose: serialize cross-instance CLAN_MEMBERS state and snapshot publication in PostgreSQL. */
  async lockScope(scope: SyncScope, client: SyncStateClient): Promise<void> {
    const resolved = this.resolveScope(scope);
    if (!this.requiresClanMembersFence(resolved)) return;
    if (typeof client.$executeRaw !== "function") {
      throw new Error("CLAN_MEMBERS synchronization requires a transactional database client");
    }
    const lockKey = `fwa-feed:${resolved.feedType}:${resolved.scopeType}:${resolved.scopeKey}`;
    await client.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
  }

  /** Purpose: load current sync-state metadata row for one feed/scope identity. */
  async getState(scope: SyncScope, client: SyncStateClient = prisma) {
    const delegate = this.getDelegate(client);
    const resolved = this.resolveScope(scope);
    if (typeof delegate.findFirst === "function") {
      return delegate.findFirst({
        where: {
          feedType: resolved.feedType,
          scopeType: resolved.scopeType,
          scopeKey: resolved.scopeKey,
        },
      });
    }
    return delegate.findUnique({
      where: this.buildCompoundScopeWhere(resolved),
    });
  }

  /** Purpose: enforce minimum interval / next-eligible guard for one feed scope. */
  async isEligible(
    scope: SyncScope,
    minimumIntervalMs: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    const state = await this.getState(scope);
    if (!state) return true;
    const nowMs = now.getTime();
    const nextEligibleMs =
      state.nextEligibleAt instanceof Date &&
      Number.isFinite(state.nextEligibleAt.getTime())
        ? state.nextEligibleAt.getTime()
        : null;
    if (nextEligibleMs !== null) return nextEligibleMs <= nowMs;
    // CoC attendance refreshes share this row but must not create a new
    // scheduler cadence when no FWA next-eligible boundary exists yet.
    if (this.requiresClanMembersFence(scope)) return true;
    if (!state.lastAttemptAt) return true;
    const elapsedMs = nowMs - state.lastAttemptAt.getTime();
    return elapsedMs >= minimumIntervalMs;
  }

  /** Purpose: persist sync-attempt timestamps before fetch/parse work starts. */
  async recordAttempt(
    scope: SyncScope,
    nextEligibleAt: Date | null,
    now: Date = new Date(),
  ): Promise<boolean> {
    const resolved = this.resolveScope(scope);
    if (this.requiresClanMembersFence(resolved)) {
      return prisma.$transaction((tx) =>
        this.recordAttemptLocked(resolved, nextEligibleAt, now, tx),
      );
    }
    return this.recordAttemptLocked(resolved, nextEligibleAt, now, prisma);
  }

  /** Purpose: register one attempt while holding the shared per-clan synchronization fence. */
  private async recordAttemptLocked(
    scope: SyncScope,
    nextEligibleAt: Date | null,
    now: Date,
    client: SyncStateClient,
  ): Promise<boolean> {
    const delegate = this.getDelegate(client);
    const resolved = this.resolveScope(scope);
    await this.lockScope(resolved, client);
    const existing = await this.getState(resolved, client);
    if (
      existing?.lastAttemptAt instanceof Date &&
      Number.isFinite(existing.lastAttemptAt.getTime()) &&
      existing.lastAttemptAt.getTime() >= now.getTime()
    ) {
      return false;
    }
    await delegate.upsert({
      where: this.buildCompoundScopeWhere(resolved),
      create: {
        feedType: resolved.feedType,
        scopeType: resolved.scopeType,
        scopeKey: resolved.scopeKey,
        lastAttemptAt: now,
        nextEligibleAt,
      },
      update: {
        lastAttemptAt: now,
        nextEligibleAt,
      },
    });
    return true;
  }

  /** Purpose: persist successful sync metadata including content hash and row counts. */
  async recordSuccess(
    params: RecordSuccessParams,
    now: Date = new Date(),
    client: SyncStateClient = prisma,
    expectedAttemptAt?: ExpectedAttemptAt,
  ): Promise<boolean> {
    const resolved = this.resolveScope(params);
    if (this.requiresClanMembersFence(resolved) && client === prisma) {
      return prisma.$transaction((tx) =>
        this.recordSuccessLocked(params, now, tx, expectedAttemptAt),
      );
    }
    return this.recordSuccessLocked(params, now, client, expectedAttemptAt);
  }

  /** Purpose: publish success metadata only for the still-current fenced attempt. */
  private async recordSuccessLocked(
    params: RecordSuccessParams,
    now: Date,
    client: SyncStateClient,
    expectedAttemptAt: ExpectedAttemptAt,
  ): Promise<boolean> {
    const delegate = this.getDelegate(client);
    const resolved = this.resolveScope(params);
    await this.lockScope(resolved, client);
    if (expectedAttemptAt) {
      const current = await this.getState(resolved, client);
      if (!current || !isSameAttemptAt(current.lastAttemptAt, expectedAttemptAt)) {
        return false;
      }
    }
    await delegate.upsert({
      where: this.buildCompoundScopeWhere(resolved),
      create: {
        feedType: resolved.feedType,
        scopeType: resolved.scopeType,
        scopeKey: resolved.scopeKey,
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastStatus: params.status,
        lastErrorCode: null,
        lastErrorSummary: null,
        lastRowCount: params.rowCount,
        lastChangedRowCount: params.changedRowCount,
        lastContentHash: params.contentHash,
        nextEligibleAt: params.nextEligibleAt,
      },
      update: {
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastStatus: params.status,
        lastErrorCode: null,
        lastErrorSummary: null,
        lastRowCount: params.rowCount,
        lastChangedRowCount: params.changedRowCount,
        lastContentHash: params.contentHash,
        nextEligibleAt: params.nextEligibleAt,
      },
    });
    return true;
  }

  /** Purpose: persist failed sync metadata and concise error diagnostics for one scope. */
  async recordFailure(
    params: RecordFailureParams,
    now: Date = new Date(),
    expectedAttemptAt?: ExpectedAttemptAt,
  ): Promise<boolean> {
    const resolved = this.resolveScope(params);
    if (this.requiresClanMembersFence(resolved)) {
      return prisma.$transaction((tx) =>
        this.recordFailureLocked(params, now, tx, expectedAttemptAt),
      );
    }
    return this.recordFailureLocked(params, now, prisma, expectedAttemptAt);
  }

  /** Purpose: publish failure diagnostics only for the still-current fenced attempt. */
  private async recordFailureLocked(
    params: RecordFailureParams,
    now: Date,
    client: SyncStateClient,
    expectedAttemptAt: ExpectedAttemptAt,
  ): Promise<boolean> {
    const delegate = this.getDelegate(client);
    const resolved = this.resolveScope(params);
    await this.lockScope(resolved, client);
    if (expectedAttemptAt) {
      const current = await this.getState(resolved, client);
      if (!current || !isSameAttemptAt(current.lastAttemptAt, expectedAttemptAt)) {
        return false;
      }
    }
    await delegate.upsert({
      where: this.buildCompoundScopeWhere(resolved),
      create: {
        feedType: resolved.feedType,
        scopeType: resolved.scopeType,
        scopeKey: resolved.scopeKey,
        lastAttemptAt: now,
        lastStatus: "FAILURE",
        lastErrorCode: params.errorCode,
        lastErrorSummary: params.errorSummary,
        nextEligibleAt: params.nextEligibleAt,
      },
      update: {
        lastAttemptAt: now,
        lastStatus: "FAILURE",
        lastErrorCode: params.errorCode,
        lastErrorSummary: params.errorSummary,
        nextEligibleAt: params.nextEligibleAt,
      },
    });
    return true;
  }
}

/** Purpose: compare a persisted attempt timestamp without allowing same-millisecond ambiguity. */
function isSameAttemptAt(value: unknown, expected: Date): boolean {
  return value instanceof Date &&
    Number.isFinite(value.getTime()) &&
    value.getTime() === expected.getTime();
}
