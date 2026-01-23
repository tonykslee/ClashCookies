import type { PlayerSnapshot } from "@prisma/client";

export function getLastSeen(
  snapshots: PlayerSnapshot[]
): Date | null {
  if (snapshots.length < 2) return null;

  for (let i = snapshots.length - 1; i > 0; i--) {
    const curr = snapshots[i];
    const prev = snapshots[i - 1];

    const changed =
      curr.trophies !== prev.trophies ||
      curr.donations !== prev.donations ||
      curr.warStars !== prev.warStars ||
      curr.builderTrophies !== prev.builderTrophies ||
      curr.capitalGold !== prev.capitalGold;

    if (changed) {
      return curr.createdAt;
    }
  }

  return snapshots[0].createdAt;
}
