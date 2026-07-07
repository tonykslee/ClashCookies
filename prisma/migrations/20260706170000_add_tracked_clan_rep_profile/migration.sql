CREATE TABLE "TrackedClanRepProfile" (
    "playerTag" VARCHAR(16) NOT NULL,
    "timeZone" VARCHAR(64),
    "updatedByDiscordUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedClanRepProfile_pkey" PRIMARY KEY ("playerTag")
);
