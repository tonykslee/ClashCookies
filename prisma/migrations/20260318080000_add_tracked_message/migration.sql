-- CreateEnum
CREATE TYPE "TrackedMessageFeatureType" AS ENUM ('FWA_BASE_SWAP', 'SYNC_TIME_POST');

-- CreateEnum
CREATE TYPE "TrackedMessageStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXPIRED', 'REPLACED', 'DELETED');

-- CreateTable
CREATE TABLE "TrackedMessage" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "featureType" "TrackedMessageFeatureType" NOT NULL,
    "status" "TrackedMessageStatus" NOT NULL DEFAULT 'ACTIVE',
    "referenceId" TEXT,
    "clanTag" TEXT,
    "expiresAt" TIMESTAMP(3),
    "remindAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrackedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedMessageClaim" (
    "id" TEXT NOT NULL,
    "trackedMessageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackedMessageClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackedMessage_messageId_key" ON "TrackedMessage"("messageId");
CREATE INDEX "TrackedMessage_featureType_idx" ON "TrackedMessage"("featureType");
CREATE INDEX "TrackedMessage_status_idx" ON "TrackedMessage"("status");
CREATE INDEX "TrackedMessage_expiresAt_idx" ON "TrackedMessage"("expiresAt");
CREATE INDEX "TrackedMessage_remindAt_idx" ON "TrackedMessage"("remindAt");
CREATE INDEX "TrackedMessage_featureType_status_idx" ON "TrackedMessage"("featureType", "status");
CREATE INDEX "TrackedMessage_guildId_featureType_status_idx" ON "TrackedMessage"("guildId", "featureType", "status");
CREATE INDEX "TrackedMessage_clanTag_featureType_status_idx" ON "TrackedMessage"("clanTag", "featureType", "status");

CREATE UNIQUE INDEX "TrackedMessageClaim_trackedMessageId_userId_clanTag_key" ON "TrackedMessageClaim"("trackedMessageId", "userId", "clanTag");
CREATE INDEX "TrackedMessageClaim_trackedMessageId_idx" ON "TrackedMessageClaim"("trackedMessageId");
CREATE INDEX "TrackedMessageClaim_userId_idx" ON "TrackedMessageClaim"("userId");
CREATE INDEX "TrackedMessageClaim_clanTag_idx" ON "TrackedMessageClaim"("clanTag");

-- AddForeignKey
ALTER TABLE "TrackedMessageClaim" ADD CONSTRAINT "TrackedMessageClaim_trackedMessageId_fkey" FOREIGN KEY ("trackedMessageId") REFERENCES "TrackedMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
