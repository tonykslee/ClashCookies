CREATE SEQUENCE IF NOT EXISTS "CurrentWar_warId_seq"
    START WITH 1000000
    INCREMENT BY 1
    MINVALUE 1000000
    NO MAXVALUE
    CACHE 1;

SELECT setval(
    '"CurrentWar_warId_seq"',
    GREATEST(
        999999,
        COALESCE((SELECT MAX("warId")::bigint FROM "ClanWarHistory"), 999999),
        COALESCE((SELECT MAX("warId")::bigint FROM "CurrentWar"), 999999),
        COALESCE((SELECT MAX("warId")::bigint FROM "WarAttacks"), 999999),
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
            999999
        )
    ),
    true
);
