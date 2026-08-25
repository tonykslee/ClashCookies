CREATE TABLE "LayoutRecord" (
    "id" TEXT NOT NULL,
    "layoutLink" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "imageUrl" TEXT,
    "postedByDiscordUserId" TEXT,
    "discordGuildId" TEXT,
    "discordChannelId" TEXT,
    "discordMessageId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "lastConfirmedAt" TIMESTAMP(3),
    "lastConfirmedByDiscordUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LayoutRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LayoutRecord_layoutLink_key"
    ON "LayoutRecord"("layoutLink");
CREATE UNIQUE INDEX "LayoutRecord_discordGuildId_discordChannelId_discordMessageId_key"
    ON "LayoutRecord"("discordGuildId", "discordChannelId", "discordMessageId");
CREATE INDEX "LayoutRecord_discordMessageId_idx"
    ON "LayoutRecord"("discordMessageId");

ALTER TABLE "FwaLayouts" ADD COLUMN "layoutId" TEXT;

CREATE INDEX "FwaLayouts_layoutId_idx"
    ON "FwaLayouts"("layoutId");

ALTER TABLE "FwaLayouts"
    ADD CONSTRAINT "FwaLayouts_layoutId_fkey"
    FOREIGN KEY ("layoutId") REFERENCES "LayoutRecord"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
