-- AlterTable
ALTER TABLE "DumpLink" ADD COLUMN "slot" INTEGER NOT NULL DEFAULT 1;

UPDATE "DumpLink" SET "slot" = 1 WHERE "slot" IS NULL;

ALTER TABLE "DumpLink" DROP CONSTRAINT "DumpLink_pkey";
ALTER TABLE "DumpLink" ADD CONSTRAINT "DumpLink_pkey" PRIMARY KEY ("guildId", "slot");
ALTER TABLE "DumpLink" ADD CONSTRAINT "DumpLink_slot_check" CHECK ("slot" >= 1 AND "slot" <= 3);
