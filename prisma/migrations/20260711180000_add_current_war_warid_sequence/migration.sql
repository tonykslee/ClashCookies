CREATE SEQUENCE IF NOT EXISTS "CurrentWar_warId_seq"
    START WITH 1000000
    INCREMENT BY 1
    MINVALUE 1000000
    NO MAXVALUE
    CACHE 1;

DO $$
DECLARE
    highest_war_id bigint;
BEGIN
    SELECT GREATEST(
        COALESCE((SELECT MAX("warId")::bigint FROM "ClanWarHistory"), 0),
        COALESCE((SELECT MAX("warId")::bigint FROM "CurrentWar"), 0),
        COALESCE((SELECT MAX("warId")::bigint FROM "WarAttacks"), 0),
        COALESCE(
            (
                SELECT MAX(
                    CASE
                        WHEN "warId" ~ '^[0-9]+$' THEN "warId"::bigint
                        ELSE NULL
                    END
                )
                FROM "WarLookup"
            ),
            0
        )
    )
    INTO highest_war_id;

    IF highest_war_id < 1000000 THEN
        PERFORM setval('"CurrentWar_warId_seq"', 1000000, false);
    ELSE
        PERFORM setval('"CurrentWar_warId_seq"', highest_war_id, true);
    END IF;
END $$;
