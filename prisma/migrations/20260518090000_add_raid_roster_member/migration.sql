-- CreateTable
CREATE TABLE "RaidRosterMember" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "playerTag" VARCHAR(16) NOT NULL,
    "createdByDiscordUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RaidRosterMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RaidRosterMember_guildId_playerTag_key"
  ON "RaidRosterMember"("guildId", "playerTag");

-- CreateIndex
CREATE INDEX "RaidRosterMember_guildId_idx"
  ON "RaidRosterMember"("guildId");

-- CreateIndex
CREATE INDEX "RaidRosterMember_playerTag_idx"
  ON "RaidRosterMember"("playerTag");
