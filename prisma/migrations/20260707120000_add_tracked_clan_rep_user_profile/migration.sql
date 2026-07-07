DROP TABLE IF EXISTS "TrackedClanRepProfile";

CREATE TABLE "TrackedClanRepUserProfile" (
    "discordUserId" TEXT NOT NULL,
    "timeZone" VARCHAR(64),
    "updatedByDiscordUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedClanRepUserProfile_pkey" PRIMARY KEY ("discordUserId")
);
