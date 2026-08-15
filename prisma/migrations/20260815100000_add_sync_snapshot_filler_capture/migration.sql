ALTER TABLE "SyncClanReadinessSnapshot"
    ADD COLUMN "fillerCaptureComplete" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "fillerPlayerTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
