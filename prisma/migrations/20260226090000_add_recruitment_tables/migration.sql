-- CreateEnum
CREATE TYPE "RecruitmentPlatform" AS ENUM ('discord', 'reddit', 'band');

-- CreateTable
CREATE TABLE "RecruitmentTemplate" (
    "id" SERIAL NOT NULL,
    "clanTag" TEXT NOT NULL,
    "requiredTH" TEXT NOT NULL,
    "focus" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "imageUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitmentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentCooldown" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "platform" "RecruitmentPlatform" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reminded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitmentCooldown_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentTemplate_clanTag_key" ON "RecruitmentTemplate"("clanTag");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentCooldown_userId_clanTag_platform_key" ON "RecruitmentCooldown"("userId", "clanTag", "platform");

-- CreateIndex
CREATE INDEX "RecruitmentCooldown_userId_expiresAt_idx" ON "RecruitmentCooldown"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "RecruitmentCooldown_expiresAt_reminded_idx" ON "RecruitmentCooldown"("expiresAt", "reminded");
