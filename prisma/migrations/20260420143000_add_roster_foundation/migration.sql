-- CreateEnum
CREATE TYPE "RosterLifecycleState" AS ENUM ('ACTIVE', 'OPEN', 'CLOSED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Roster" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "rosterType" TEXT NOT NULL,
    "rosterCategory" TEXT,
    "title" TEXT NOT NULL,
    "clanTag" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL,
    "displayTimezone" TEXT,
    "lifecycleState" "RosterLifecycleState" NOT NULL DEFAULT 'OPEN',
    "postedChannelId" TEXT,
    "postedMessageId" TEXT,
    "postedMessageUrl" TEXT,
    "postedAt" TIMESTAMP(3),
    "createdByDiscordUserId" TEXT,
    "updatedByDiscordUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Roster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RosterGroup" (
    "id" TEXT NOT NULL,
    "rosterId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RosterGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RosterSignup" (
    "id" TEXT NOT NULL,
    "rosterId" TEXT NOT NULL,
    "groupId" TEXT,
    "playerTag" TEXT NOT NULL,
    "playerName" TEXT,
    "discordUserId" TEXT NOT NULL,
    "signedUpAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RosterSignup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Roster_postedMessageId_key" ON "Roster"("postedMessageId");

-- CreateIndex
CREATE INDEX "Roster_guildId_rosterType_lifecycleState_idx" ON "Roster"("guildId", "rosterType", "lifecycleState");

-- CreateIndex
CREATE INDEX "Roster_guildId_clanTag_idx" ON "Roster"("guildId", "clanTag");

-- CreateIndex
CREATE INDEX "Roster_guildId_startsAt_idx" ON "Roster"("guildId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "RosterGroup_rosterId_key_key" ON "RosterGroup"("rosterId", "key");

-- CreateIndex
CREATE INDEX "RosterGroup_rosterId_sortOrder_idx" ON "RosterGroup"("rosterId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "RosterSignup_rosterId_playerTag_key" ON "RosterSignup"("rosterId", "playerTag");

-- CreateIndex
CREATE INDEX "RosterSignup_rosterId_discordUserId_idx" ON "RosterSignup"("rosterId", "discordUserId");

-- CreateIndex
CREATE INDEX "RosterSignup_rosterId_groupId_idx" ON "RosterSignup"("rosterId", "groupId");

-- AddForeignKey
ALTER TABLE "RosterGroup" ADD CONSTRAINT "RosterGroup_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "Roster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterSignup" ADD CONSTRAINT "RosterSignup_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "Roster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterSignup" ADD CONSTRAINT "RosterSignup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "RosterGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
