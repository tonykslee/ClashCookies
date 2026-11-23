\set ON_ERROR_STOP on

-- FB-002 P4d-1a.3 B1: separately approved bounded per-war SELECT.
-- This file reads only ClanWarHistory and ClanWarParticipation.
\set clan_tag '#2YUYLJCGV'
\set window_start '2026-09-23 00:00:00+00'
\set window_end '2026-11-22 00:00:00+00'
\if :{?capture_final}
\else
\set capture_final off
\endif

BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL TIME ZONE 'UTC';

SELECT current_user AS current_user,
       current_database() AS database_name,
       current_setting('transaction_read_only') AS transaction_read_only,
       current_setting('TimeZone') AS reporting_timezone,
       current_setting('statement_timeout') AS statement_timeout,
       current_setting('lock_timeout') AS lock_timeout;

DO $environment_check$
BEGIN
  IF NOT (
    current_user = 'clashcookies_dusk_readonly'
    AND current_database() = 'clashcookies'
    AND current_setting('transaction_read_only') = 'on'
    AND upper(current_setting('TimeZone')) = 'UTC'
    AND current_setting('statement_timeout')::interval = interval '5 seconds'
    AND current_setting('lock_timeout')::interval = interval '1 second'
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles r
      WHERE r.rolname = current_user
        AND r.rolcanlogin
        AND NOT r.rolsuper
        AND NOT r.rolcreaterole
        AND NOT r.rolcreatedb
        AND NOT r.rolbypassrls
        AND NOT r.rolreplication
        AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
        AND NOT has_database_privilege(current_user, current_database(), 'CREATE')
    )
  ) THEN
    RAISE EXCEPTION 'STOP: role, database, privilege posture, or transaction settings failed';
  END IF;
END
$environment_check$;

SELECT CASE WHEN to_regclass('public."ClanWarHistory"') IS NULL
         THEN false ELSE has_table_privilege(
           current_user, 'public."ClanWarHistory"', 'SELECT'
         ) END
       AND CASE WHEN to_regclass('public."ClanWarParticipation"') IS NULL
         THEN false ELSE has_table_privilege(
           current_user, 'public."ClanWarParticipation"', 'SELECT'
         ) END
       AND CASE WHEN to_regclass('public."ClanWarHistory"') IS NULL
         THEN false ELSE NOT has_table_privilege(
           current_user, 'public."ClanWarHistory"', 'INSERT'
         ) AND NOT has_table_privilege(
           current_user, 'public."ClanWarHistory"', 'UPDATE'
         ) AND NOT has_table_privilege(
           current_user, 'public."ClanWarHistory"', 'DELETE'
         ) AND NOT has_table_privilege(
           current_user, 'public."ClanWarHistory"', 'TRUNCATE'
         ) AND NOT has_table_privilege(
           current_user, 'public."ClanWarHistory"', 'REFERENCES'
         ) AND NOT has_table_privilege(
           current_user, 'public."ClanWarHistory"', 'TRIGGER'
         ) END
       AND CASE WHEN to_regclass('public."ClanWarParticipation"') IS NULL
         THEN false ELSE NOT has_table_privilege(
           current_user, 'public."ClanWarParticipation"', 'INSERT'
         ) AND NOT has_table_privilege(
           current_user, 'public."ClanWarParticipation"', 'UPDATE'
         ) AND NOT has_table_privilege(
           current_user, 'public."ClanWarParticipation"', 'DELETE'
         ) AND NOT has_table_privilege(
           current_user, 'public."ClanWarParticipation"', 'TRUNCATE'
         ) AND NOT has_table_privilege(
           current_user, 'public."ClanWarParticipation"', 'REFERENCES'
         ) AND NOT has_table_privilege(
           current_user, 'public."ClanWarParticipation"', 'TRIGGER'
         ) END
       AS permissions_valid,
       to_regclass('public."ClanWarHistory"') IS NOT NULL
         AS clan_war_history_exists,
       to_regclass('public."ClanWarParticipation"') IS NOT NULL
         AS clan_war_participation_exists;

DO $table_check$
BEGIN
  IF to_regclass('public."ClanWarHistory"') IS NULL
     OR to_regclass('public."ClanWarParticipation"') IS NULL
     OR NOT (
       CASE WHEN to_regclass('public."ClanWarHistory"') IS NULL
         THEN false ELSE has_table_privilege(
           current_user, 'public."ClanWarHistory"', 'SELECT'
         ) END
     )
     OR NOT (
       CASE WHEN to_regclass('public."ClanWarParticipation"') IS NULL
         THEN false ELSE has_table_privilege(
           current_user, 'public."ClanWarParticipation"', 'SELECT'
         ) END
     )
     OR (
       CASE WHEN to_regclass('public."ClanWarHistory"') IS NULL
         THEN false ELSE has_table_privilege(
           current_user, 'public."ClanWarHistory"', 'INSERT'
         ) OR has_table_privilege(
           current_user, 'public."ClanWarHistory"', 'UPDATE'
         ) OR has_table_privilege(
           current_user, 'public."ClanWarHistory"', 'DELETE'
         ) OR has_table_privilege(
           current_user, 'public."ClanWarHistory"', 'TRUNCATE'
         ) OR has_table_privilege(
           current_user, 'public."ClanWarHistory"', 'REFERENCES'
         ) OR has_table_privilege(
           current_user, 'public."ClanWarHistory"', 'TRIGGER'
         ) END
     )
     OR (
       CASE WHEN to_regclass('public."ClanWarParticipation"') IS NULL
         THEN false ELSE has_table_privilege(
           current_user, 'public."ClanWarParticipation"', 'INSERT'
         ) OR has_table_privilege(
           current_user, 'public."ClanWarParticipation"', 'UPDATE'
         ) OR has_table_privilege(
           current_user, 'public."ClanWarParticipation"', 'DELETE'
         ) OR has_table_privilege(
           current_user, 'public."ClanWarParticipation"', 'TRUNCATE'
         ) OR has_table_privilege(
           current_user, 'public."ClanWarParticipation"', 'REFERENCES'
         ) OR has_table_privilege(
           current_user, 'public."ClanWarParticipation"', 'TRIGGER'
         ) END
     ) THEN
    RAISE EXCEPTION 'STOP: required history table or privilege check failed';
  END IF;
END
$table_check$;

DO $index_check$
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class i
       JOIN pg_catalog.pg_index x ON x.indexrelid = i.oid
       JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND t.relname = 'ClanWarHistory'
         AND i.relname = 'WarClanHistory_clanTag_warEndTime_idx'
         AND x.indisvalid
         AND x.indisready
         AND ARRAY(
           SELECT a.attname::text
           FROM generate_subscripts(x.indkey, 1) AS key_positions(ord)
           LEFT JOIN pg_catalog.pg_attribute a
             ON a.attrelid = x.indrelid
            AND a.attnum = x.indkey[key_positions.ord]
           WHERE key_positions.ord <= 2
           ORDER BY key_positions.ord
         ) = ARRAY['clanTag', 'warEndTime']::text[]
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class i
       JOIN pg_catalog.pg_index x ON x.indexrelid = i.oid
       JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND t.relname = 'ClanWarParticipation'
         AND i.relname = 'ClanWarParticipation_warId_idx'
         AND x.indisvalid
         AND x.indisready
         AND ARRAY(
           SELECT a.attname::text
           FROM generate_subscripts(x.indkey, 1) AS key_positions(ord)
           LEFT JOIN pg_catalog.pg_attribute a
             ON a.attrelid = x.indrelid
            AND a.attnum = x.indkey[key_positions.ord]
           WHERE key_positions.ord <= 1
           ORDER BY key_positions.ord
         ) = ARRAY['warId']::text[]
     ) THEN
    RAISE EXCEPTION 'STOP: required history index is missing, invalid, or has unexpected ownership/column order';
  END IF;
END
$index_check$;

SELECT btrim(:'clan_tag') = '#2YUYLJCGV'
       AND TIMESTAMPTZ :'window_start' = TIMESTAMPTZ '2026-09-23 00:00:00+00'
       AND TIMESTAMPTZ :'window_end' = TIMESTAMPTZ '2026-11-22 00:00:00+00'
       AND TIMESTAMPTZ :'window_end' > TIMESTAMPTZ :'window_start'
       AND TIMESTAMPTZ :'window_end' - TIMESTAMPTZ :'window_start' = interval '60 days'
       AS all_inputs_valid
\gset timestamp_select_

\if :timestamp_select_all_inputs_valid
\else
  \echo 'STOP: scope or UTC interval was changed from the approved fixture'
  DO $invalid_parameter$
  BEGIN
    RAISE EXCEPTION 'STOP: scope or UTC interval was changed from the approved fixture';
  END
  $invalid_parameter$;
\endif

\if :capture_final
  \if :{?final_output}
    \pset format csv
    \pset footer off
    \o :final_output
  \else
    \echo 'STOP: final_output is required when capture_final is enabled'
    DO $missing_output$
    BEGIN
      RAISE EXCEPTION 'STOP: final_output is required when capture_final is enabled';
    END
    $missing_output$;
  \endif
\endif

WITH parameters AS (
  SELECT btrim(:'clan_tag') AS clan_tag,
         TIMESTAMPTZ :'window_start' AS window_start,
         TIMESTAMPTZ :'window_end' AS window_end
),
selected_wars AS (
  SELECT h."warId" AS dusk_war_id,
         h."clanTag" AS clan_tag,
         h."opponentTag" AS opponent_tag,
         h."warStartTime" AS war_start_time,
         h."warEndTime" AS history_end_time
  FROM parameters p
  CROSS JOIN LATERAL (
    SELECT h."warId",
           h."clanTag",
           h."opponentTag",
           h."warStartTime",
           h."warEndTime"
    FROM "ClanWarHistory" h
    WHERE h."clanTag" = p.clan_tag
      AND h."warEndTime" IS NOT NULL
      AND h."warEndTime" >= p.window_start
      AND h."warEndTime" < p.window_end
    ORDER BY h."warEndTime" DESC,
             h."warStartTime" DESC,
             h."warId" DESC
    LIMIT 20
  ) h
),
participation_aggregates AS (
  SELECT s.dusk_war_id,
         s.clan_tag,
         s.opponent_tag,
         s.war_start_time,
         s.history_end_time,
         count(p."id")::bigint AS participation_row_count,
         count(DISTINCT p."playerTag")::bigint
           AS distinct_participation_identity_count,
         count(DISTINCT p."warEndTime")::bigint
           AS distinct_participation_end_timestamp_count,
         count(*) FILTER (
           WHERE p."id" IS NOT NULL
             AND p."warEndTime" IS NULL
         )::bigint AS null_participation_end_time_count,
         min(p."warEndTime") AS min_participation_end_time,
         max(p."warEndTime") AS max_participation_end_time,
         count(*) FILTER (
           WHERE p."id" IS NOT NULL
             AND p."warStartTime" IS DISTINCT FROM s.war_start_time
         )::bigint AS start_time_mismatch_count,
         count(*) FILTER (
           WHERE p."id" IS NOT NULL
             AND p."opponentTag" IS DISTINCT FROM s.opponent_tag
         )::bigint AS opponent_tag_mismatch_count
  FROM selected_wars s
  LEFT JOIN "ClanWarParticipation" p
    ON p."warId" = s.dusk_war_id::text
   AND p."clanTag" = s.clan_tag
  GROUP BY s.dusk_war_id, s.clan_tag, s.opponent_tag,
           s.war_start_time, s.history_end_time
),
identity_guild_counts AS (
  SELECT s.dusk_war_id,
         s.clan_tag,
         p."playerTag" AS player_identity,
         count(DISTINCT p."guildId")::bigint AS guild_count
  FROM selected_wars s
  JOIN "ClanWarParticipation" p
    ON p."warId" = s.dusk_war_id::text
   AND p."clanTag" = s.clan_tag
  GROUP BY s.dusk_war_id, s.clan_tag, p."playerTag"
),
cross_guild_summary AS (
  SELECT dusk_war_id,
         clan_tag,
         count(*) FILTER (WHERE guild_count > 1)::bigint
           AS cross_guild_duplicate_identity_count,
         coalesce(sum(greatest(guild_count - 1, 0)), 0)::bigint
           AS cross_guild_duplicate_copy_count
  FROM identity_guild_counts
  GROUP BY dusk_war_id, clan_tag
),
assembled AS (
  SELECT p.*,
         coalesce(c.cross_guild_duplicate_identity_count, 0)::bigint
           AS cross_guild_duplicate_identity_count,
         coalesce(c.cross_guild_duplicate_copy_count, 0)::bigint
           AS cross_guild_duplicate_copy_count,
         (
           p.participation_row_count > 0
           AND p.distinct_participation_end_timestamp_count = 1
           AND p.null_participation_end_time_count = 0
         ) AS participation_end_time_internally_consistent
  FROM participation_aggregates p
  LEFT JOIN cross_guild_summary c
    ON c.dusk_war_id = p.dusk_war_id
   AND c.clan_tag = p.clan_tag
)
SELECT dusk_war_id,
       clan_tag,
       opponent_tag,
       war_start_time,
       history_end_time,
       participation_row_count,
       distinct_participation_identity_count,
       distinct_participation_end_timestamp_count,
       null_participation_end_time_count,
       min_participation_end_time,
       max_participation_end_time,
       start_time_mismatch_count,
       opponent_tag_mismatch_count,
       cross_guild_duplicate_identity_count,
       cross_guild_duplicate_copy_count,
       participation_end_time_internally_consistent,
       CASE
         WHEN participation_end_time_internally_consistent
           THEN round(extract(epoch FROM (
             history_end_time - min_participation_end_time
           )))::bigint
         ELSE NULL
       END AS history_minus_participation_seconds
FROM assembled
ORDER BY history_end_time DESC, war_start_time DESC, dusk_war_id DESC;

\if :capture_final
  \o
  \pset format aligned
  \pset footer on
\endif

ROLLBACK;
