ALTER TABLE "UnlinkedAlertConfig"
ADD COLUMN "routingMode" TEXT NOT NULL DEFAULT 'CLAN_LOG';

UPDATE "UnlinkedAlertConfig"
SET "routingMode" = 'CUSTOM'
WHERE "channelId" IS NOT NULL;

ALTER TABLE "UnlinkedAlertConfig"
ALTER COLUMN "channelId" DROP NOT NULL;
