-- AlterTable
ALTER TABLE "DumpLink"
ADD COLUMN     "clanInfoJson" JSONB,
ADD COLUMN     "clanInfoFetchedAt" TIMESTAMP(3);
