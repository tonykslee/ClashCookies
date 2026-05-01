-- CreateEnum
CREATE TYPE "PlayerLinkSource" AS ENUM ('SELF_SERVICE', 'EMBED_SELF_SERVICE', 'ADMIN_CREATE', 'IMPORT_CLASHPERK', 'LEGACY');

-- CreateEnum
CREATE TYPE "PlayerLinkVerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PlayerLinkVerificationMethod" AS ENUM ('PLAYER_API_TOKEN', 'ADMIN_OVERRIDE', 'IMPORT', 'LEGACY');

-- AlterTable
ALTER TABLE "PlayerLink"
ADD COLUMN "linkSource" "PlayerLinkSource" NOT NULL DEFAULT 'LEGACY',
ADD COLUMN "verificationStatus" "PlayerLinkVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN "verificationMethod" "PlayerLinkVerificationMethod",
ADD COLUMN "verifiedAt" TIMESTAMP(3),
ADD COLUMN "verifiedByDiscordUserId" TEXT,
ADD COLUMN "lastVerifiedAt" TIMESTAMP(3),
ADD COLUMN "verificationFailureReason" TEXT,
ADD COLUMN "importBatchKey" TEXT;

UPDATE "PlayerLink"
SET "verificationMethod" = 'LEGACY'
WHERE "verificationMethod" IS NULL;

-- CreateIndex
CREATE INDEX "PlayerLink_verificationStatus_idx" ON "PlayerLink"("verificationStatus");

-- CreateIndex
CREATE INDEX "PlayerLink_linkSource_idx" ON "PlayerLink"("linkSource");

-- CreateIndex
CREATE INDEX "PlayerLink_discordUserId_verificationStatus_idx" ON "PlayerLink"("discordUserId", "verificationStatus");