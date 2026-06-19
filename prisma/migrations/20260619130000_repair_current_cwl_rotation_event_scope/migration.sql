WITH incident_season AS (
  SELECT '2026-06'::text AS season
),
explicit_repair_candidates AS (
  SELECT *
  FROM (VALUES
    ('cmqhiv81g01i4tr40oiyg33ig'::text, '#2C0UURLQU'::text, '2026-06'::text, 5::integer, TIMESTAMP(3) '2026-06-17 03:39:25.684', 'legacy:2026-06:#2C0UURLQU'::text, 'cmqkolj7800yly017ec8wb9qe'::text),
    ('cmqhcyu4j05wt4ll0715ru1bh'::text, '#2C998J8LY'::text, '2026-06'::text, 3::integer, TIMESTAMP(3) '2026-06-17 00:54:16.579', 'legacy:2026-06:#2C998J8LY'::text, 'cmqkolpxc0105y017ee11ejb1'::text),
    ('cmqhcwtp105wp4ll03qzam7au'::text, '#2CCR8UYG0'::text, '2026-06'::text, 5::integer, TIMESTAMP(3) '2026-06-17 00:52:42.709', 'legacy:2026-06:#2CCR8UYG0'::text, 'cmqkolnd800zdy017nbp6eo7a'::text),
    ('cmqh1bx6j0fp9gxnd4njg87ef'::text, '#2CCUGYG8V'::text, '2026-06'::text, 1::integer, TIMESTAMP(3) '2026-06-16 19:28:31.675', 'legacy:2026-06:#2CCUGYG8V'::text, 'cmqkolyfb011py01743rhinex'::text),
    ('cmqhcy2yp05wr4ll0lesacl7k'::text, '#2CGG9GGRV'::text, '2026-06'::text, 4::integer, TIMESTAMP(3) '2026-06-17 00:53:41.376', 'legacy:2026-06:#2CGG9GGRV'::text, 'cmqkolfu100xty017110lj7yu'::text),
    ('cmqh1edsu0grcgxndx3zp8kux'::text, '#2CLVCCG2R'::text, '2026-06'::text, 1::integer, TIMESTAMP(3) '2026-06-16 19:30:26.527', 'legacy:2026-06:#2CLVCCG2R'::text, 'cmqkom0j1012hy0178cj40kw5'::text),
    ('cmqhjzn3f05i5tr406yddz1pc'::text, '#2CPLCLRQL'::text, '2026-06'::text, 4::integer, TIMESTAMP(3) '2026-06-17 04:10:51.435', 'legacy:2026-06:#2CPLCLRQL'::text, 'cmqkol87800w9y0174mi8rtut'::text),
    ('cmqh1mnc80hp3gxndzusw87l7'::text, '#2CY29QRGU'::text, '2026-06'::text, 1::integer, TIMESTAMP(3) '2026-06-16 19:36:52.136', 'legacy:2026-06:#2CY29QRGU'::text, 'cmqkomfjm015ly017l1oinli3'::text),
    ('cmqh1knmq0hp1gxndp5vkx52a'::text, '#2CYGCCGVC'::text, '2026-06'::text, 1::integer, TIMESTAMP(3) '2026-06-16 19:35:19.203', 'legacy:2026-06:#2CYGCCGVC'::text, 'cmqkom5400139y017ytj05qeo'::text),
    ('cmqhatho700024ll0y3yojyfq'::text, '#2RJC2UCC2'::text, '2026-06'::text, 3::integer, TIMESTAMP(3) '2026-06-16 23:54:07.927', 'legacy:2026-06:#2RJC2UCC2'::text, 'cmqkolvge010xy017nesp9vtk'::text),
    ('cmqh1999g0fp7gxndssslydqs'::text, '#2RQCVGGVL'::text, '2026-06'::text, 1::integer, TIMESTAMP(3) '2026-06-16 19:26:27.364', 'legacy:2026-06:#2RQCVGGVL'::text, 'cmqkom8wg0141y017adcxnjrw'::text),
    ('cmqharu4r00xjbarui311v5xf'::text, '#2RVP0J80G'::text, '2026-06'::text, 3::integer, TIMESTAMP(3) '2026-06-16 23:52:50.759', 'legacy:2026-06:#2RVP0J80G'::text, 'cmqkolbyb00x1y0179ojj2k2v'::text),
    ('cmqhcv98s05114ll07y06cy7o'::text, '#2U0JGVC8Y'::text, '2026-06'::text, 1::integer, TIMESTAMP(3) '2026-06-17 00:51:29.548', 'legacy:2026-06:#2U0JGVC8Y'::text, 'cmqkomaz0014ty017fcrmdp3t'::text)
  ) AS candidate("planId", "clanTag", "repairSeason", "version", "createdAt", "legacyEventInstanceId", "currentEventInstanceId")
  CROSS JOIN incident_season s
  WHERE candidate."repairSeason" = s.season
),
resolved_current_events AS (
  SELECT DISTINCT ON (ec."clanTag")
    ec."clanTag",
    ec."eventInstanceId" AS "currentEventInstanceId"
  FROM "CwlEventClan" ec
  JOIN "CwlEventInstance" ei
    ON ei.id = ec."eventInstanceId"
  CROSS JOIN incident_season s
  WHERE ec."isCurrent" = true
    AND ei.season = s.season
  ORDER BY ec."clanTag", ec."lastObservedAt" DESC, ec."firstObservedAt" DESC, ec."eventInstanceId" DESC
),
eligible_candidates AS (
  SELECT
    plan.id,
    candidate."currentEventInstanceId"
  FROM explicit_repair_candidates candidate
  JOIN "CwlRotationPlan" plan
    ON plan.id = candidate."planId"
   AND plan."clanTag" = candidate."clanTag"
   AND plan.season = candidate."repairSeason"
   AND plan.version = candidate.version
   AND plan."createdAt" = candidate."createdAt"
   AND plan."eventInstanceId" = candidate."legacyEventInstanceId"
   AND plan."isActive" = true
  JOIN resolved_current_events current_event
    ON current_event."clanTag" = plan."clanTag"
   AND current_event."currentEventInstanceId" = candidate."currentEventInstanceId"
  JOIN "CwlEventClan" source_event
    ON source_event."clanTag" = plan."clanTag"
   AND source_event."eventInstanceId" = plan."eventInstanceId"
   AND source_event."isCurrent" = false
  WHERE NOT EXISTS (
    SELECT 1
    FROM "CwlRotationPlan" current_plan
    WHERE current_plan.season = candidate."repairSeason"
      AND current_plan."clanTag" = plan."clanTag"
      AND current_plan."eventInstanceId" = candidate."currentEventInstanceId"
      AND current_plan."isActive" = true
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "CwlRotationPlan" current_version
    WHERE current_version.season = candidate."repairSeason"
      AND current_version."clanTag" = plan."clanTag"
      AND current_version."eventInstanceId" = candidate."currentEventInstanceId"
      AND current_version.version = plan.version
  )
)
UPDATE "CwlRotationPlan" plan
SET "eventInstanceId" = eligible_candidates."currentEventInstanceId"
FROM eligible_candidates
WHERE plan.id = eligible_candidates.id;
