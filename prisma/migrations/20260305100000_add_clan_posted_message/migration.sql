CREATE TABLE "ClanPostedMessage" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "event" TEXT,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "messageUrl" TEXT NOT NULL,
    "warId" TEXT,
    "syncNum" INTEGER,
    "configHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClanPostedMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClanPostedMessage_guildId_clanTag_idx" ON "ClanPostedMessage"("guildId", "clanTag");
CREATE INDEX "ClanPostedMessage_clanTag_warId_idx" ON "ClanPostedMessage"("clanTag", "warId");
CREATE UNIQUE INDEX "ClanPostedMessage_guildId_clanTag_warId_type_event_key"
ON "ClanPostedMessage"("guildId", "clanTag", "warId", "type", "event");
