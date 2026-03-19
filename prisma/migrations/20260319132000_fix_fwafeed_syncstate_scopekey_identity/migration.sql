-- Remove legacy NULL-scope rows that are superseded by existing resolved keys.
DELETE FROM "FwaFeedSyncState" AS legacy
USING "FwaFeedSyncState" AS resolved
WHERE legacy."scopeKey" IS NULL
  AND legacy."scopeType" = 'GLOBAL'
  AND resolved."feedType" = legacy."feedType"
  AND resolved."scopeType" = legacy."scopeType"
  AND resolved."scopeKey" = '__global__';

DELETE FROM "FwaFeedSyncState" AS legacy
USING "FwaFeedSyncState" AS resolved
WHERE legacy."scopeKey" IS NULL
  AND legacy."scopeType" = 'TRACKED_CLANS'
  AND resolved."feedType" = legacy."feedType"
  AND resolved."scopeType" = legacy."scopeType"
  AND resolved."scopeKey" = '__tracked_clans__';

-- Collapse duplicate NULL identities before mapping to deterministic scope keys.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "feedType", "scopeType"
      ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
    ) AS rn
  FROM "FwaFeedSyncState"
  WHERE "scopeKey" IS NULL
    AND "scopeType" IN ('GLOBAL', 'TRACKED_CLANS')
)
DELETE FROM "FwaFeedSyncState" AS row
USING ranked
WHERE row."id" = ranked."id"
  AND ranked.rn > 1;

-- Backfill deterministic non-null identities.
UPDATE "FwaFeedSyncState"
SET "scopeKey" = '__global__'
WHERE "scopeKey" IS NULL
  AND "scopeType" = 'GLOBAL';

UPDATE "FwaFeedSyncState"
SET "scopeKey" = '__tracked_clans__'
WHERE "scopeKey" IS NULL
  AND "scopeType" = 'TRACKED_CLANS';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "FwaFeedSyncState"
    WHERE "scopeKey" IS NULL
  ) THEN
    RAISE EXCEPTION 'FwaFeedSyncState.scopeKey migration failed: unresolved NULL scopeKey rows remain';
  END IF;
END $$;

ALTER TABLE "FwaFeedSyncState"
ALTER COLUMN "scopeKey" SET NOT NULL;

