ALTER TABLE "WarHistoryAttack" RENAME TO "WarAttacks";
ALTER TABLE "WarEventLogSubscription" RENAME TO "CurrentWar";
ALTER TABLE "WarClanHistory" RENAME TO "ClanWarHistory";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relkind = 'S'
      AND relname = 'WarClanHistory_warId_seq'
  ) THEN
    EXECUTE 'ALTER SEQUENCE "WarClanHistory_warId_seq" RENAME TO "ClanWarHistory_warId_seq"';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class
    WHERE relkind = 'S'
      AND relname = 'ClanWarHistory_warId_seq'
  ) THEN
    EXECUTE 'ALTER TABLE "ClanWarHistory" ALTER COLUMN "warId" SET DEFAULT nextval(''"ClanWarHistory_warId_seq"''::regclass)';
  END IF;
END
$$;
