import type { FwaFeedType } from "@prisma/client";
import { prisma } from "../../prisma";

/** Purpose: persist distributed-sweep cursor progress for long-running global feed jobs. */
export class FwaFeedCursorService {
  /** Purpose: read cursor row for one feed type. */
  async getCursor(feedType: FwaFeedType) {
    return prisma.fwaFeedCursor.findUnique({
      where: { feedType },
    });
  }

  /** Purpose: upsert cursor position after each sweep chunk run. */
  async saveCursor(params: { feedType: FwaFeedType; lastScopeKey: string | null; lastRunAt: Date }): Promise<void> {
    await prisma.fwaFeedCursor.upsert({
      where: { feedType: params.feedType },
      update: {
        lastScopeKey: params.lastScopeKey,
        lastRunAt: params.lastRunAt,
      },
      create: {
        feedType: params.feedType,
        lastScopeKey: params.lastScopeKey,
        lastRunAt: params.lastRunAt,
      },
    });
  }
}
