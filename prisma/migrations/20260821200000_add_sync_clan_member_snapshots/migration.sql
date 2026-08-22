-- CreateTable
CREATE TABLE "SyncClanMemberSnapshot" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "syncTime" TIMESTAMP(3) NOT NULL,
    "clanTag" VARCHAR(16) NOT NULL,
    "playerTag" VARCHAR(16) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncClanMemberSnapshot_pkey" PRIMARY KEY ("id")
);

-- The same normalized physical membership fact may only be captured once.
CREATE UNIQUE INDEX "SyncClanMemberSnapshot_guildId_syncTime_clanTag_playerTag_key"
    ON "SyncClanMemberSnapshot"("guildId", "syncTime", "clanTag", "playerTag");

CREATE INDEX "SyncClanMemberSnapshot_guildId_playerTag_syncTime_idx"
    ON "SyncClanMemberSnapshot"("guildId", "playerTag", "syncTime");

CREATE INDEX "SyncClanMemberSnapshot_guildId_clanTag_syncTime_idx"
    ON "SyncClanMemberSnapshot"("guildId", "clanTag", "syncTime");

CREATE INDEX "SyncClanMemberSnapshot_guildId_syncTime_playerTag_idx"
    ON "SyncClanMemberSnapshot"("guildId", "syncTime", "playerTag");
