-- CreateTable
CREATE TABLE "DumpLink" (
    "guildId" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "updatedByDiscordUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DumpLink_pkey" PRIMARY KEY ("guildId")
);

-- CreateIndex
CREATE INDEX "DumpLink_updatedAt_idx" ON "DumpLink"("updatedAt");
