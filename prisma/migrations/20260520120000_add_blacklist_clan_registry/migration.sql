-- CreateTable
CREATE TABLE "BlacklistClan" (
    "clanTag" TEXT NOT NULL,
    "clanName" TEXT,
    "sourceLabel" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlacklistClan_pkey" PRIMARY KEY ("clanTag")
);

-- CreateIndex
CREATE INDEX "BlacklistClan_active_lastSeenAt_idx" ON "BlacklistClan"("active", "lastSeenAt");

-- CreateIndex
CREATE INDEX "BlacklistClan_sourceLabel_lastSeenAt_idx" ON "BlacklistClan"("sourceLabel", "lastSeenAt");
