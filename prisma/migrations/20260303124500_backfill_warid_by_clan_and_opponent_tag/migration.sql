-- Retroactive backfill: WarHistoryAttack.warId by clanTag + opponent tag.
UPDATE "WarHistoryAttack" a
SET "warId" = m."warId"
FROM LATERAL (
  SELECT h."warId"
  FROM "WarClanHistory" h
  WHERE UPPER(REPLACE(COALESCE(h."clanTag", ''), '#', '')) = UPPER(REPLACE(COALESCE(a."clanTag", ''), '#', ''))
    AND UPPER(REPLACE(COALESCE(h."opponentTag", ''), '#', '')) = UPPER(REPLACE(COALESCE(a."opponentClanTag", ''), '#', ''))
  ORDER BY
    CASE WHEN h."warStartTime" = a."warStartTime" THEN 0 ELSE 1 END,
    ABS(EXTRACT(EPOCH FROM (h."warStartTime" - a."warStartTime")))
  LIMIT 1
) m
WHERE a."warId" IS NULL
  AND m."warId" IS NOT NULL;

-- Retroactive backfill: WarEventLogSubscription.warId by clanTag + lastOpponentTag.
UPDATE "WarEventLogSubscription" s
SET "warId" = m."warId"
FROM LATERAL (
  SELECT h."warId"
  FROM "WarClanHistory" h
  WHERE UPPER(REPLACE(COALESCE(h."clanTag", ''), '#', '')) = UPPER(REPLACE(COALESCE(s."clanTag", ''), '#', ''))
    AND UPPER(REPLACE(COALESCE(h."opponentTag", ''), '#', '')) = UPPER(REPLACE(COALESCE(s."lastOpponentTag", ''), '#', ''))
  ORDER BY
    CASE
      WHEN s."lastWarStartTime" IS NOT NULL AND h."warStartTime" = s."lastWarStartTime" THEN 0
      WHEN s."lastWarStartTime" IS NOT NULL THEN 1
      ELSE 2
    END,
    ABS(EXTRACT(EPOCH FROM (h."warStartTime" - COALESCE(s."lastWarStartTime", h."warStartTime"))))
  LIMIT 1
) m
WHERE s."warId" IS NULL
  AND m."warId" IS NOT NULL;
