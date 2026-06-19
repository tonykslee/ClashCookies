WITH current_season AS (
  SELECT to_char(timezone('utc', now()), 'YYYY-MM') AS season
),
resolved_current_events AS (
  SELECT DISTINCT ON (ec."clanTag")
    ec."clanTag",
    ec."eventInstanceId" AS "currentEventInstanceId"
  FROM "CwlEventClan" ec
  JOIN "CwlEventInstance" ei
    ON ei.id = ec."eventInstanceId"
  CROSS JOIN current_season cs
  WHERE ec."isCurrent" = true
    AND ei.season = cs.season
  ORDER BY ec."clanTag", ec."lastObservedAt" DESC, ec."firstObservedAt" DESC, ec."eventInstanceId" DESC
),
ranked_current_plan_candidates AS (
  SELECT
    plan.id,
    plan."clanTag",
    plan."eventInstanceId" AS "legacyEventInstanceId",
    plan.version,
    plan."updatedAt",
    plan."createdAt",
    current_event."currentEventInstanceId",
    ROW_NUMBER() OVER (
      PARTITION BY plan."clanTag"
      ORDER BY plan.version DESC, plan."updatedAt" DESC, plan.id DESC
    ) AS "candidateRank"
  FROM "CwlRotationPlan" plan
  JOIN resolved_current_events current_event
    ON current_event."clanTag" = plan."clanTag"
  CROSS JOIN current_season cs
  WHERE plan.season = cs.season
    AND plan."isActive" = true
    AND plan."eventInstanceId" <> current_event."currentEventInstanceId"
    AND NOT EXISTS (
      SELECT 1
      FROM "CwlRotationPlan" current_plan
      WHERE current_plan.season = cs.season
        AND current_plan."clanTag" = plan."clanTag"
        AND current_plan."eventInstanceId" = current_event."currentEventInstanceId"
        AND current_plan."isActive" = true
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "CwlRotationPlan" current_version
      WHERE current_version.season = cs.season
        AND current_version."clanTag" = plan."clanTag"
        AND current_version."eventInstanceId" = current_event."currentEventInstanceId"
        AND current_version.version = plan.version
    )
)
UPDATE "CwlRotationPlan" plan
SET "eventInstanceId" = ranked."currentEventInstanceId"
FROM ranked_current_plan_candidates ranked
WHERE plan.id = ranked.id
  AND ranked."candidateRank" = 1;
