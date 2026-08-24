CREATE TABLE "FwaWeightAlertConfig" (
    "clanTag" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "thresholdDays" INTEGER NOT NULL DEFAULT 7,
    "updatedByDiscordUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaWeightAlertConfig_pkey" PRIMARY KEY ("clanTag"),
    CONSTRAINT "FwaWeightAlertConfig_clanTag_fkey"
      FOREIGN KEY ("clanTag") REFERENCES "TrackedClan"("tag") ON DELETE CASCADE ON UPDATE CASCADE
);
