import { SettingsService } from "./SettingsService";
import { ActiveWarSyncResolutionService } from "./ActiveWarSyncResolutionService";
import { PointsSyncService } from "./PointsSyncService";

const activeWarSyncResolutionService = new ActiveWarSyncResolutionService(
  new PointsSyncService(),
);

/** Purpose: read the latest persisted sync baseline without pre-decrementing it. */
export async function getSourceOfTruthSync(
  _settings: SettingsService,
  guildId?: string | null,
): Promise<number | null> {
  void _settings;
  return activeWarSyncResolutionService.getLatestPersistedSyncBaseline({
    guildId: guildId ?? null,
  });
}
