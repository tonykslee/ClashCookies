-- Preserve immutable bot-observed ADD/REMOVE transitions without coupling history to TrackedMessage cleanup.
CREATE TYPE "SyncReactionHistoryAction" AS ENUM ('ADD', 'REMOVE');

CREATE TABLE "SyncReactionHistory" (
    "id" TEXT NOT NULL,
    "eventOrder" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "syncTime" TIMESTAMP(3) NOT NULL,
    "syncRootTrackedId" TEXT NOT NULL,
    "syncRootMessageId" TEXT NOT NULL,
    "trackedMessageId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "clanTag" VARCHAR(16) NOT NULL,
    "action" "SyncReactionHistoryAction" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncReactionHistory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SyncReactionHistory_eventOrder_key"
    ON "SyncReactionHistory"("eventOrder");
CREATE INDEX "SyncReactionHistory_guildId_syncTime_clanTag_eventOrder_idx"
    ON "SyncReactionHistory"("guildId", "syncTime", "clanTag", "eventOrder");
CREATE INDEX "SyncReactionHistory_syncRootTrackedId_observedAt_idx"
    ON "SyncReactionHistory"("syncRootTrackedId", "observedAt");
CREATE INDEX "SyncReactionHistory_trackedMessageId_observedAt_idx"
    ON "SyncReactionHistory"("trackedMessageId", "observedAt");
CREATE INDEX "SyncReactionHistory_discordUserId_syncTime_observedAt_idx"
    ON "SyncReactionHistory"("discordUserId", "syncTime", "observedAt");
