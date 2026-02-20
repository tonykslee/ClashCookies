-- CreateTable
CREATE TABLE "PlayerSnapshot" (
    "id" SERIAL NOT NULL,
    "tag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "trophies" INTEGER NOT NULL,
    "donations" INTEGER NOT NULL,
    "warStars" INTEGER NOT NULL,
    "builderTrophies" INTEGER NOT NULL,
    "capitalGold" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerActivity" (
    "tag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "lastDonationAt" TIMESTAMP(3),
    "lastCapitalAt" TIMESTAMP(3),
    "lastTrophyAt" TIMESTAMP(3),
    "lastWarAt" TIMESTAMP(3),
    "lastBuilderAt" TIMESTAMP(3),
    "lastTrophies" INTEGER,
    "lastWarStars" INTEGER,
    "lastBuilderTrophies" INTEGER,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerActivity_pkey" PRIMARY KEY ("tag")
);

-- CreateIndex
CREATE INDEX "PlayerSnapshot_tag_createdAt_idx" ON "PlayerSnapshot"("tag", "createdAt");
