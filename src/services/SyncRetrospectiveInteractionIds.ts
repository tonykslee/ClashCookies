const SYNC_RETROSPECTIVE_CLAN_PREFIX = "sync-retro:clan";

export function buildSyncRetrospectiveClanSelectCustomId(
  syncNumber: number,
  menuIndex: number,
): string {
  return `${SYNC_RETROSPECTIVE_CLAN_PREFIX}:${syncNumber}:${menuIndex}`;
}

export type SyncRetrospectiveClanSelectCustomId = {
  syncNumber: number;
  menuIndex: number;
};

/** Purpose: parse only the versioned four-part retrospective clan menu id. */
export function parseSyncRetrospectiveClanSelectCustomId(
  customId: string,
): SyncRetrospectiveClanSelectCustomId | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 4 || parts[0] !== "sync-retro" || parts[1] !== "clan") return null;
  if (!/^[1-9]\d*$/.test(parts[2] ?? "") || !/^\d+$/.test(parts[3] ?? "")) return null;

  const syncNumber = Number(parts[2]);
  const menuIndex = Number(parts[3]);
  if (!Number.isSafeInteger(syncNumber) || syncNumber <= 0) return null;
  if (!Number.isSafeInteger(menuIndex) || menuIndex < 0 || menuIndex > 3) return null;
  return { syncNumber, menuIndex };
}

export function isSyncRetrospectiveClanSelectCustomId(customId: string): boolean {
  return parseSyncRetrospectiveClanSelectCustomId(customId) !== null;
}
