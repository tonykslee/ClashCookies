import type { FwaFeedScopeType, FwaFeedSyncStatus, FwaFeedType } from "@prisma/client";
import { prisma } from "../../prisma";

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

/** Purpose: own persistent sync-state metadata updates for all fwa feed scopes. */
export class FwaFeedSyncStateService {
  private getDelegate() {
    return prisma.fwaFeedSyncState as any;
  }

  private buildCompoundScopeWhere(scope: SyncScope) {
    return {
      feedType_scopeType_scopeKey: {
        feedType: scope.feedType,
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
      },
    };
  }

  /** Purpose: load current sync-state metadata row for one feed/scope identity. */
  async getState(scope: SyncScope) {
    const delegate = this.getDelegate();
    if (typeof delegate.findFirst === "function") {
      return delegate.findFirst({
        where: {
          feedType: scope.feedType,
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
        },
      });
    }
    return delegate.findUnique({
      where: this.buildCompoundScopeWhere(scope),
    });
  }

  /** Purpose: enforce minimum interval / next-eligible guard for one feed scope. */
  async isEligible(scope: SyncScope, minimumIntervalMs: number, now: Date = new Date()): Promise<boolean> {
    const state = await this.getState(scope);
    if (!state) return true;
    const nowMs = now.getTime();
    const nextEligibleMs =
      state.nextEligibleAt instanceof Date && Number.isFinite(state.nextEligibleAt.getTime())
        ? state.nextEligibleAt.getTime()
        : null;
    if (nextEligibleMs !== null && nextEligibleMs > nowMs) return false;
    if (!state.lastAttemptAt) return true;
    const elapsedMs = nowMs - state.lastAttemptAt.getTime();
    return elapsedMs >= minimumIntervalMs;
  }

  /** Purpose: persist sync-attempt timestamps before fetch/parse work starts. */
  async recordAttempt(scope: SyncScope, nextEligibleAt: Date | null, now: Date = new Date()): Promise<void> {
    const delegate = this.getDelegate();
    await delegate.upsert({
      where: this.buildCompoundScopeWhere(scope),
      create: {
        feedType: scope.feedType,
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        lastAttemptAt: now,
        nextEligibleAt,
      },
      update: {
        lastAttemptAt: now,
        nextEligibleAt,
      },
    });
  }

  /** Purpose: persist successful sync metadata including content hash and row counts. */
  async recordSuccess(params: RecordSuccessParams, now: Date = new Date()): Promise<void> {
    const delegate = this.getDelegate();
    await delegate.upsert({
      where: this.buildCompoundScopeWhere(params),
      create: {
        feedType: params.feedType,
        scopeType: params.scopeType,
        scopeKey: params.scopeKey,
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
  }

  /** Purpose: persist failed sync metadata and concise error diagnostics for one scope. */
  async recordFailure(params: RecordFailureParams, now: Date = new Date()): Promise<void> {
    const delegate = this.getDelegate();
    await delegate.upsert({
      where: this.buildCompoundScopeWhere(params),
      create: {
        feedType: params.feedType,
        scopeType: params.scopeType,
        scopeKey: params.scopeKey,
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
  }
}
