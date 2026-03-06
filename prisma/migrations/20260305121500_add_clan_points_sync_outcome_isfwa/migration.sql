ALTER TABLE "ClanPointsSync"
ADD COLUMN "outcome" TEXT,
ADD COLUMN "isFwa" BOOLEAN;

UPDATE "ClanPointsSync"
SET "isFwa" = false
WHERE "isFwa" IS NULL;

ALTER TABLE "ClanPointsSync"
ALTER COLUMN "isFwa" SET NOT NULL;
