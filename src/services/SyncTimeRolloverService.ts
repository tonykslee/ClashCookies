import { SettingsService } from "./SettingsService";

const PREVIOUS_SYNC_KEY = "previousSyncNum";
const SYNC_ROLLOVER_TARGET_EPOCH_KEY = "sync_rollover_target_epoch";
const SYNC_ROLLOVER_APPLIED_EPOCH_KEY = "sync_rollover_applied_epoch";

export type SyncRolloverResult = {
  applied: boolean;
  reason:
    | "applied"
    | "target_missing"
    | "target_invalid"
    | "not_due_yet"
    | "already_applied"
    | "previous_sync_missing";
  targetEpoch: number | null;
  previousSync: number | null;
  nextPreviousSync: number | null;
};

/** Purpose: schedule and apply previousSyncNum rollover once sync-time target is due. */
export class SyncTimeRolloverService {
  constructor(private readonly settings: SettingsService = new SettingsService()) {}

  async schedule(targetEpochSeconds: number): Promise<void> {
    if (!Number.isFinite(targetEpochSeconds) || targetEpochSeconds <= 0) return;
    await this.settings.set(
      SYNC_ROLLOVER_TARGET_EPOCH_KEY,
      String(Math.trunc(targetEpochSeconds))
    );
  }

  async maybeApplyDueRollover(nowEpochSeconds = Math.floor(Date.now() / 1000)): Promise<SyncRolloverResult> {
    const targetRaw = await this.settings.get(SYNC_ROLLOVER_TARGET_EPOCH_KEY);
    if (!targetRaw) {
      return {
        applied: false,
        reason: "target_missing",
        targetEpoch: null,
        previousSync: null,
        nextPreviousSync: null,
      };
    }

    const targetEpoch = Number(targetRaw);
    if (!Number.isFinite(targetEpoch) || targetEpoch <= 0) {
      return {
        applied: false,
        reason: "target_invalid",
        targetEpoch: null,
        previousSync: null,
        nextPreviousSync: null,
      };
    }

    if (Math.trunc(nowEpochSeconds) < Math.trunc(targetEpoch)) {
      return {
        applied: false,
        reason: "not_due_yet",
        targetEpoch: Math.trunc(targetEpoch),
        previousSync: null,
        nextPreviousSync: null,
      };
    }

    const appliedRaw = await this.settings.get(SYNC_ROLLOVER_APPLIED_EPOCH_KEY);
    const appliedEpoch = Number(appliedRaw);
    if (Number.isFinite(appliedEpoch) && Math.trunc(appliedEpoch) === Math.trunc(targetEpoch)) {
      return {
        applied: false,
        reason: "already_applied",
        targetEpoch: Math.trunc(targetEpoch),
        previousSync: null,
        nextPreviousSync: null,
      };
    }

    const previousRaw = await this.settings.get(PREVIOUS_SYNC_KEY);
    const previousSync = Number(previousRaw);
    if (!Number.isFinite(previousSync)) {
      return {
        applied: false,
        reason: "previous_sync_missing",
        targetEpoch: Math.trunc(targetEpoch),
        previousSync: null,
        nextPreviousSync: null,
      };
    }

    const nextPreviousSync = Math.trunc(previousSync) + 1;
    await this.settings.set(PREVIOUS_SYNC_KEY, String(nextPreviousSync));
    await this.settings.set(SYNC_ROLLOVER_APPLIED_EPOCH_KEY, String(Math.trunc(targetEpoch)));
    return {
      applied: true,
      reason: "applied",
      targetEpoch: Math.trunc(targetEpoch),
      previousSync: Math.trunc(previousSync),
      nextPreviousSync,
    };
  }
}
