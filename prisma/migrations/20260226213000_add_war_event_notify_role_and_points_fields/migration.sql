CREATE TYPE "WarMatchType" AS ENUM ('FWA', 'BL', 'MM');

ALTER TABLE "WarEventLogSubscription"
ADD COLUMN "notifyRole" TEXT,
ADD COLUMN "fwaPoints" INTEGER,
ADD COLUMN "opponentFwaPoints" INTEGER,
ADD COLUMN "outcome" TEXT,
ADD COLUMN "matchType" "WarMatchType";
